# Context — Study Guide Pipeline

Sebuah API asinkron yang mengubah **materi belajar mentah** menjadi **panduan belajar terstruktur**.
Client mengirim teks sumber, API menerima dan mengantrekan, worker memproses lewat pipeline
berlapis, dan hasilnya diambil kemudian.

## Bahasa

### Source Text
Materi belajar mentah yang dikirim client — bab buku, transkrip kuliah, catatan, artikel panjang.
Ini satu-satunya sumber kebenaran untuk isi guide. Model **tidak** boleh menambahkan konsep yang
tidak ada di Source Text; kalau materi tipis, guide-nya ikut tipis.

### Study Job
Satu permintaan pembuatan guide. Menyimpan Source Text, preferensi belajar (level, bahasa),
status pemrosesan, dan — kalau gagal — alasannya. Diciptakan oleh API, diselesaikan oleh worker.
Dibuat, bukan diubah: client tidak pernah mengedit Study Job.

### Concept
Satu gagasan yang bisa diajarkan, diekstrak dari Source Text. Punya judul, penjelasan, dan alasan
kenapa penting. Urutannya bermakna — Concept diurutkan sesuai alur belajar, bukan urutan kemunculan
di Source Text.

### Quiz Question
Satu soal pemeriksaan pemahaman beserta jawabannya, diturunkan dari penjelasan sebuah Concept.
Setiap Quiz Question menunjuk Concept yang diujinya; soal tanpa Concept yang valid dibuang.

### Study Guide
Gabungan Concept + Quiz Question milik satu Study Job. Bukan tabel tersendiri — "Study Guide" adalah
cara bicara tentang hasil lengkap satu Study Job. Study Guide hanya ada dalam bentuk lengkap:
tidak ada guide setengah jadi yang terlihat client.

### Status Study Job
- `PENDING` — tersimpan dan terantre, belum disentuh worker.
- `PROCESSING` — worker sedang menjalankan pipeline.
- `COMPLETED` — Study Guide tersimpan utuh.
- `FAILED` — pipeline berhenti; nol hasil tersimpan, alasan tercatat.

Status hanya maju; `COMPLETED` dan `FAILED` bersifat final.

### Grounding
Aturan bahwa setiap Concept dan Quiz Question harus berasal dari Source Text. Jumlah Concept
mengikuti kepadatan materi, bukan angka yang ditetapkan di muka — materi tipis menghasilkan guide
tipis, dan itu hasil yang benar, bukan kegagalan.

### Unprocessable Source
Source Text yang tidak memuat cukup materi untuk membentuk Study Guide (di bawah dua Concept).
Ini kegagalan **permanen**: mengulang pekerjaan yang sama tidak akan mengubah hasilnya, jadi Study
Job langsung `FAILED` tanpa percobaan ulang. Berbeda dari kegagalan **transient** (jaringan, rate
limit, gangguan penyedia model) yang layak dicoba lagi.

### Retry
Percobaan ulang atas Study Job yang sama setelah kegagalan transient. Selama percobaan ulang,
status tetap `PROCESSING` — client tidak pernah melihat `FAILED` yang kemudian menjadi `COMPLETED`.
`FAILED` hanya ditulis ketika tidak ada lagi yang bisa dicoba.
