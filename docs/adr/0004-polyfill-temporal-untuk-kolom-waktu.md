# 4. Polyfill Temporal untuk kolom waktu

Tanggal: 2026-09-12

## Status

Diterima

## Konteks

Prisma 8 memetakan `DateTime` ke codec `pg/timestamptz-temporal@1`, yang membaca dan menulis
nilainya sebagai `Temporal.Instant` melalui global `Temporal`. Node.js belum menyediakan global itu
— diperiksa pada Node 22.22 dan 24.19, keduanya `typeof Temporal === "undefined"`.

Akibatnya bukan sekadar persoalan tipe. Membaca satu baris yang punya kolom `DateTime` melempar saat
dekode:

```
Codec 'pg/timestamptz-temporal@1' cannot decode a value because this runtime has
no global Temporal implementation.  (RUNTIME.TEMPORAL_UNAVAILABLE)
```

Artinya setiap `StudyJob` yang dibaca akan gagal, karena `createdAt` ada di setiap baris. Pesan
error dari Prisma sendiri menawarkan dua jalan keluar: memasang polyfill Temporal sebelum client
dibuat, atau mendeklarasikan kolomnya dengan codec `*String` sehingga yang dibaca dan ditulis adalah
teks milik PostgreSQL.

## Keputusan

Pasang `temporal-polyfill` dan impor varian globalnya sebagai **import pertama** di modul yang
membuat client database (`src/utils/db.ts`). Urutan eksekusi modul ESM mengikuti urutan import, jadi
polyfill sudah terpasang sebelum `postgres()` dipanggil.

Kolom waktu tetap `DateTime`, dan nilainya tetap `Temporal.Instant` di seluruh aplikasi. Waktu
sekarang ditulis dengan `Temporal.Now.instant()`, dan cursor paginasi membawa hasil
`instant.toString()` yang dibaca kembali dengan `Temporal.Instant.from(...)`.

## Konsekuensi

`@default(now())` dan seluruh perbandingan waktu bekerja sebagaimana dideklarasikan schema, dan
`JSON.stringify` mengeluarkan ISO 8601 lewat `toJSON()` milik `Instant` — jadi kontrak HTTP tidak
perlu penyesuaian apa pun.

Harganya adalah sebuah ketergantungan tambahan dan satu urutan import yang wajib dipatuhi: modul apa
pun yang menyentuh database harus lewat `src/utils/db.ts`, dan memindahkan import polyfill dari
posisi teratas akan memunculkan kembali kegagalan runtime di atas. Komentar di berkas itu menyatakan
alasannya supaya tidak dirapikan orang lain tanpa sengaja.

Keputusan ini layak ditinjau kembali ketika Node menyediakan `Temporal` secara asli; ketika itu
terjadi, polyfill bisa dicabut tanpa mengubah kode aplikasi.
