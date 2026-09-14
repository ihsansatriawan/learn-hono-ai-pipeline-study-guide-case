# 2. Study Guide ditulis atomik

Tanggal: 2026-09-12

## Status

Diterima

## Konteks

Pipeline menghasilkan Concept di langkah kedua dan Quiz Question di langkah ketiga. Menyimpan
setiap hasil begitu tersedia adalah pilihan yang wajar: progres terlihat, dan pekerjaan yang sudah
selesai tidak terbuang kalau langkah berikutnya gagal.

Tetapi worker berjalan di bawah percobaan ulang. Sebuah Study Job yang gagal transient di langkah
ketiga akan mengulang **dari langkah pertama**, dan menemukan Concept dari percobaan sebelumnya
sudah ada di database. Tanpa penanganan khusus, percobaan kedua menggandakan Concept.

Persoalan kedua: `GET /jobs/:id` harus mengembalikan hasil `null` ketika belum siap. Kalau Concept
sudah tersimpan sementara Quiz Question belum, "siap" menjadi keadaan bergradasi yang harus
didefinisikan dan dijelaskan, dan client bisa membaca guide tanpa soal tanpa tahu itu belum selesai.

## Keputusan

Pipeline berjalan sepenuhnya di memori. Tidak ada hasil antara yang menyentuh database.

Ketika keempat langkah selesai, seluruh Study Guide — semua Concept, semua Quiz Question, dan
perubahan status menjadi `COMPLETED` — ditulis dalam satu `db.transaction(...)`. Transaksi itu
commit atau tidak sama sekali.

Study Job yang gagal karena itu selalu punya nol baris hasil, sehingga percobaan ulang mulai dari
keadaan bersih tanpa perlu membersihkan apa pun lebih dulu.

## Konsekuensi

Percobaan ulang idempoten tanpa kode idempotensi: tidak ada tulisan parsial yang bisa digandakan.

`guide: null` punya satu arti tunggal — belum `COMPLETED` — sehingga client cukup memeriksa status.

Harganya, pekerjaan dari langkah yang sudah berhasil terbuang setiap kali percobaan ulang terjadi;
sebuah kegagalan transient di langkah ketiga membayar ulang token langkah pertama dan kedua. Untuk
pipeline tiga panggilan model, biaya itu diterima; kalau langkah bertambah banyak atau menjadi jauh
lebih mahal, keputusan ini yang pertama harus ditinjau ulang.

Konsekuensi lain: tidak ada progres per langkah yang bisa ditunjukkan ke client. Study Job yang
sedang berjalan hanya berkata `PROCESSING`.
