# 3. Konsep diikat slug lintas langkah

Tanggal: 2026-09-12

## Status

Diterima

## Konteks

Langkah kedua menjelaskan seluruh Concept dalam satu panggilan model, dan langkah ketiga membuat
soal untuk seluruh Concept dalam satu panggilan lagi. Tiga panggilan per Study Job, berapa pun
jumlah Concept — biaya dan lama pemrosesan bisa diperkirakan.

Harga dari memborong adalah penyejajaran. Model bisa mengembalikan penjelasan dalam urutan berbeda,
menggabungkan dua Concept, atau menjatuhkan satu di tengah daftar panjang. Bersandar pada posisi
array berarti bersandar pada janji yang tidak dijamin penyedia model mana pun, dan penjelasan yang
tertukar antar Concept adalah kesalahan yang tidak terlihat: hasilnya tetap valid secara skema,
tetap terbaca, dan tetap salah.

## Keputusan

Langkah pertama memberi setiap Concept sebuah `slug` yang stabil dan unik. Skema keluaran langkah
kedua dan ketiga mewajibkan setiap item membawa `slug` itu kembali.

Langkah keempat tidak memanggil model sama sekali. Ia mencocokkan berdasarkan slug, bukan posisi:

- slug yang tidak dikenal — dibuang; model menghasilkan sesuatu yang tidak diminta.
- slug yang seharusnya ada tapi hilang — kegagalan transient; Study Job diulang.
- kurang dari dua Concept di langkah pertama — Unprocessable Source; kegagalan permanen.

## Konsekuensi

Penjelasan dan soal tidak mungkin tertukar antar Concept tanpa terdeteksi; kegagalan penyejajaran
berubah dari kesalahan senyap menjadi kegagalan yang terang.

Langkah keempat menjadi satu-satunya tempat aturan kelengkapan ditegakkan, dan ia bisa diuji tanpa
menyentuh jaringan karena tidak memanggil model.

Harganya, skema keluaran langkah kedua dan ketiga jadi lebih ramai, dan prompt harus menegaskan
kewajiban mengembalikan slug. Sebagian kapasitas model terpakai untuk menyalin pengenal alih-alih
menulis isi.
