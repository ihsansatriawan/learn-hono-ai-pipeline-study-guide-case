# 1. Klasifikasi kegagalan permanen vs transient

Tanggal: 2026-09-12

## Status

Diterima

## Konteks

Worker menjalankan pipeline empat langkah yang tiga di antaranya memanggil model bahasa. Kegagalan
di sana datang dari dua dunia yang berbeda:

- **Transient** — jaringan putus, rate limit 429, gangguan 5xx penyedia model. Pekerjaan yang sama
  besar kemungkinan berhasil kalau diulang beberapa detik kemudian.
- **Permanen** — Source Text tidak memuat cukup materi untuk membentuk Study Guide. Mengulang
  pekerjaan yang identik akan menghasilkan kegagalan yang identik.

BullMQ tidak mengetahui perbedaan ini; ia hanya melihat exception. Kalau semua kegagalan
diperlakukan sama, input yang jelas-jelas tidak bisa diproses tetap menghabiskan tiga percobaan
dan token pada tiap percobaan, dan demonstrasi kegagalan harus menunggu backoff selesai.

Ada juga persoalan kedua: kapan status `FAILED` ditulis. Menulis `FAILED` di dalam `catch` lalu
melempar ulang membuat Study Job yang akhirnya berhasil sempat terlihat `FAILED` oleh client yang
sedang polling.

## Keputusan

Worker membedakan kedua kelas kegagalan lewat tipe error.

Kegagalan permanen diwakili kelas error tersendiri. Ketika tertangkap, worker menulis `FAILED`
beserta alasannya dan **kembali secara normal** — tidak melempar, sehingga BullMQ menganggap
pekerjaan selesai dan tidak mengulang.

Kegagalan transient dilempar ulang. BullMQ mengulang sampai tiga percobaan dengan backoff
eksponensial. Selama itu status tetap `PROCESSING`. `FAILED` baru ditulis pada percobaan terakhir,
yaitu ketika `job.attemptsMade + 1 >= job.opts.attempts`.

Akibatnya, `FAILED` selalu final: status tidak pernah mundur.

## Konsekuensi

Status yang dilihat client selalu monoton maju, sehingga client boleh berhenti polling begitu
melihat `FAILED`.

Input yang tidak bisa diproses gagal seketika, tanpa token terbuang dan tanpa menunggu backoff.

Harganya: worker kadang menelan error alih-alih melemparnya, dan itu tidak lazim — pembaca yang
tidak tahu alasannya akan menyangkanya bug. Konsekuensi lain, setiap kelas kegagalan baru harus
secara sadar digolongkan; kegagalan yang tidak dikenali diperlakukan sebagai transient, sehingga
kesalahan penggolongan berbiaya percobaan ulang yang sia-sia, bukan kehilangan pekerjaan.
