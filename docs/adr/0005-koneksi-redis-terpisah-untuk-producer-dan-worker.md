# 5. Koneksi Redis terpisah untuk producer dan worker

Tanggal: 2026-09-13

## Status

Diterima

## Konteks

API dan worker semula memakai satu objek konfigurasi koneksi Redis yang sama, dengan
`maxRetriesPerRequest: null`. Nilai itu disyaratkan BullMQ untuk Worker: perintah blocking yang
dipakai Worker untuk menunggu pekerjaan harus boleh menunggu tanpa batas.

Tetapi kebutuhan producer justru kebalikannya, dan menyamakan keduanya menghapus jaminan yang
ditegakkan ADR sebelumnya: router membungkus pengantrean dengan `try/catch` supaya Study Job yang
gagal diantrekan ditandai `FAILED` dan client menerima `503`, bukan `202` yang berbohong.

Pengujian menunjukkan jaminan itu tidak pernah berlaku. Dengan Redis dimatikan, `POST /jobs` tidak
membalas `503`; permintaannya menggantung sampai client menyerah setelah 30 detik, dan barisnya
tertinggal `PENDING` tanpa alasan. Dengan `maxRetriesPerRequest: null`, perintah ioredis tidak
pernah gugur, sehingga `catch` di router tidak pernah dijalankan.

Menyetel `enableOfflineQueue: false` menyembuhkan kasus "Redis mati setelah sempat tersambung", tapi
tidak menyembuhkan "Redis tidak pernah tersambung sejak proses menyala": di situ BullMQ menunggu
koneksi siap sebelum mengirim perintah apa pun, dan penantian itu tidak dibatasi apa pun.

## Keputusan

Producer dan worker memakai konfigurasi koneksi yang berbeda, masing-masing sesuai kebutuhannya.

Worker tetap `maxRetriesPerRequest: null`. Producer memakai `enableOfflineQueue: false`,
`maxRetriesPerRequest: 3`, dan `commandTimeout`, sehingga perintah gagal alih-alih menunggu.

Karena itu pun belum menutup kasus koneksi yang tidak pernah terbentuk, pengantrean dibungkus
batas waktu eksplisit (`enqueueStudyGuideJob`, 5 detik). Lewat dari itu, pengantrean dianggap gagal.

Konsekuensi dari batas waktu: sebuah perintah yang terlambat masih mungkin sampai ke Redis setelah
Study Job ditandai `FAILED`. Karena itu worker menolak mengerjakan job yang statusnya sudah final —
`COMPLETED` maupun `FAILED` — sesuai aturan "status hanya maju" di CONTEXT.md.

API tetap menyala walau Redis mati. Koneksi dihangatkan saat boot dengan batas waktu, dan
kegagalannya hanya dicatat sebagai peringatan: pembacaan tetap berguna, dan penulisan menolak
dengan jujur.

## Konsekuensi

`POST /jobs` kini membalas `503` dalam puluhan milidetik ketika Redis mati setelah tersambung, dan
dalam lima detik ketika Redis tidak pernah tersambung. Study Job-nya `FAILED` dengan alasan yang
menyebut penyebabnya, dan `GET /jobs` tetap melayani.

Harganya adalah dua konfigurasi koneksi yang harus dipahami sebagai pasangan: menyalin nilai worker
ke producer akan diam-diam mengembalikan permintaan yang menggantung. Komentar di
`src/worker/config.ts` menyatakan alasannya di kedua sisi.

Batas waktu lima detik adalah angka yang dipilih, bukan yang diukur. Kalau Redis pernah wajar-wajar
saja memakan waktu lebih lama untuk menerima satu perintah, angka itu yang pertama harus ditinjau.
