# Study Guide Pipeline API

API asinkron yang mengubah **materi belajar mentah** menjadi **panduan belajar terstruktur**:
konsep-konsep berpenjelasan beserta soal pemeriksaan pemahaman.

Client mengirim teks sumber dan API langsung membalas dengan ID job. Sebuah worker terpisah
menjalankan pipeline empat langkah dengan panggilan model sungguhan, lalu menyimpan hasilnya di
PostgreSQL untuk diambil kemudian.

Bahasa domainnya ada di [CONTEXT.md](./CONTEXT.md); keputusan yang tidak jelas dari kodenya
dijelaskan di [docs/adr/](./docs/adr/).

## Alur permintaan

```text
Client                        API                          Worker
  |                            |                              |
  |-- POST /jobs ------------->|                              |
  |                            |-- simpan StudyJob PENDING     |
  |                            |-- enqueue { studyJobId } ---->|
  |<-- 202 + job ID -----------|                              |
  |                            |                    PROCESSING
  |                            |                    1 ekstrak konsep    (model)
  |                            |                    2 jelaskan konsep   (model)
  |                            |                    3 buat soal         (model)
  |                            |                    4 rakit + validasi  (TypeScript)
  |                            |                    satu transaksi -> COMPLETED
  |-- GET /jobs/:id ---------->|                              |
  |<-- guide tersimpan --------|                              |
```

Antrean bernama `study-guide-queue`, tugasnya `generate-study-guide`. Payload antrean hanya
membawa `{ studyJobId }` — PostgreSQL tetap satu-satunya sumber kebenaran untuk teks sumber.

## Pipeline

Langkah 1 menarik konsep **hanya** dari teks sumber dan memberi setiap konsep sebuah `slug`.
Langkah 2 dan 3 wajib mengembalikan slug itu, dan langkah 4 mencocokkannya — bukan bersandar pada
urutan array. Langkah 4 tidak memanggil model sama sekali; di situlah kelengkapan ditegakkan.
Alasannya di [ADR-0003](./docs/adr/0003-konsep-diikat-slug-lintas-langkah.md).

Jumlah konsep mengikuti kepadatan materi (2–12), soal 1–3 per konsep. Materi tipis menghasilkan
guide tipis; materi yang tidak mengajarkan apa pun menghasilkan job `FAILED`.

## Endpoint

| Endpoint | Tanggung jawab | Respons |
| --- | --- | --- |
| `POST /jobs` | Validasi materi dan antrekan pekerjaan | `202` · ID job + status |
| `GET /jobs` | Daftar job berpaginasi beserta guide tersimpan | `200` · `{ jobs, nextCursor }` |
| `GET /jobs/:id` | Status dan guide satu job | `200` · job, atau `404` |
| `GET /health` | Pemeriksaan hidup untuk skrip demo | `200` |

### POST /jobs

```bash
curl -i -X POST http://localhost:3100/jobs \
  -H 'Content-Type: application/json' \
  -d '{"sourceText":"<materi 500-20000 karakter>","level":"intermediate","language":"id"}'
```

`level` — `beginner` (default) | `intermediate` | `advanced`. `language` — `id` (default) | `en`.
Materi di bawah 500 atau di atas 20.000 karakter ditolak `400`.

`503` berarti antrean menolak pekerjaan; job ditandai `FAILED` dan tidak akan dikerjakan.
Ini disengaja: lebih baik menolak terang-terangan daripada membalas `202` untuk pekerjaan
yang tidak akan pernah dijalankan. Pengantrean dibatasi 5 detik, dan API tetap melayani
pembacaan walau Redis mati — lihat
[ADR-0005](./docs/adr/0005-koneksi-redis-terpisah-untuk-producer-dan-worker.md).

### GET /jobs/:id

```json
{
  "id": "6d2e5223-01c7-4203-9ed1-d392a94f38f6",
  "status": "COMPLETED",
  "level": "intermediate",
  "language": "id",
  "createdAt": "2026-09-12T13:12:44.031Z",
  "completedAt": "2026-09-12T13:13:08.116Z",
  "failureReason": null,
  "guide": {
    "concepts": [
      {
        "id": "…",
        "order": 1,
        "title": "Call stack dan sifat single-threaded",
        "explanation": "…",
        "whyItMatters": "…"
      }
    ],
    "quiz": [
      { "id": "…", "conceptId": "…", "question": "…", "answer": "…", "difficulty": "easy" }
    ]
  }
}
```

`guide` bernilai `null` persis sampai status `COMPLETED` — tidak ada guide setengah jadi yang
terlihat client, karena hasil ditulis dalam satu transaksi
([ADR-0002](./docs/adr/0002-study-guide-ditulis-atomik.md)). `sourceText` tidak pernah
dikembalikan: client baru saja mengirimnya, dan ukurannya membuat polling mahal.

### GET /jobs

```bash
curl 'http://localhost:3100/jobs?limit=20'
```

Urut `createdAt` menurun, `limit` maksimal 50. Lanjutkan halaman dengan `?cursor=<nextCursor>`.

## Status job

| Status | Arti |
| --- | --- |
| `PENDING` | Tersimpan dan terantre, belum disentuh worker |
| `PROCESSING` | Worker sedang menjalankan pipeline (termasuk saat sedang diulang) |
| `COMPLETED` | Guide tersimpan utuh |
| `FAILED` | Pipeline berhenti; nol hasil tersimpan, `failureReason` terisi |

Status hanya maju. `COMPLETED` dan `FAILED` final, jadi client boleh berhenti polling begitu
melihat keduanya.

**Kegagalan transient** (jaringan, 429, 5xx penyedia model) diulang sampai tiga kali dengan backoff
eksponensial, dan status tetap `PROCESSING` selama itu. **Kegagalan permanen** — materi yang tidak
memuat konsep yang bisa diajarkan — langsung `FAILED` tanpa percobaan ulang.
Lihat [ADR-0001](./docs/adr/0001-klasifikasi-kegagalan-permanen-vs-transient.md).

## Stack

| Tool | Peran |
| --- | --- |
| Hono + Node.js 22 | Server HTTP di port `3100` |
| Zod | Validasi request, schema keluaran model, dan validasi environment |
| Prisma 8 (Prisma Next) | Query bertipe, enum ber-CHECK, relasi, transaksi |
| PostgreSQL 16 | Menyimpan StudyJob, Concept, QuizQuestion |
| BullMQ 6 + Redis 7 | Antrean pekerjaan latar |
| Anvia (`@anvia/core`, `@anvia/openai`) | Pipeline berlangkah + keluaran terstruktur |
| temporal-polyfill | Global `Temporal` yang dibutuhkan codec waktu Prisma 8 |

## Menjalankan

Butuh Node.js **22.18 atau lebih baru** (`.nvmrc` menunjuk 22.22.2), pnpm, Docker Compose, dan
kunci API penyedia OpenAI-compatible.

```bash
pnpm install
cp .env.example .env       # lalu isi OPENAI_API_KEY
docker compose up -d
pnpm contract:emit
pnpm db:init
```

Port host sengaja berbeda dari proyek lain di folder yang sama (`hono-prisma-bullmq` memakai
55432/6380/3000, `feedback-pipeline-api` memakai 55433/6381/3000), supaya semuanya bisa hidup
bersamaan:

| Layanan | Host | Container |
| --- | --- | --- |
| PostgreSQL | `localhost:55434` | `5432` |
| Redis | `localhost:6382` | `6379` |
| API | `localhost:3100` | — |

Jalankan dua proses di dua terminal:

```bash
pnpm dev          # API
pnpm worker:dev   # worker
```

Keduanya memvalidasi environment saat boot dan menolak start kalau ada yang kurang, alih-alih
gagal diam-diam di tengah job.

## Demo alur penuh

```bash
pnpm demo
```

Skrip ini menyalakan dan mematikan worker + API sendiri, lalu menjalankan enam langkah:
mengirim transkrip kuliah sungguhan, menunggu sampai `COMPLETED`, mendaftar job, membaca satu
guide, mengirim materi yang tidak bisa diproses untuk menunjukkan jalur `FAILED` beserta `404`
untuk ID tak dikenal, dan terakhir **mematikan lalu menyalakan ulang API** untuk membuktikan guide
yang tersimpan identik sesudahnya. Artefak responsnya tertinggal di `.demo/`.

Jalur kegagalan permanen memakai `scripts/fixtures/source-noise.txt` (struk belanja). Itu
bergantung pada penilaian model: kalau suatu saat model memaksakan dua konsep dari struk, skrip
melaporkannya alih-alih gagal.

## Perintah

| Perintah | Kegunaan |
| --- | --- |
| `pnpm dev` / `pnpm worker:dev` | API dan worker dengan file watching |
| `pnpm start` / `pnpm worker:start` | Sekali jalan tanpa watching |
| `pnpm contract:emit` | Regenerasi kontrak Prisma setelah schema diubah |
| `pnpm db:init` / `pnpm db:update` | Terapkan schema ke database |
| `pnpm db:verify` | Cocokkan database dengan kontrak |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm demo` | Demonstrasi alur penuh |

Setelah mengubah `prisma/schema.prisma`: `pnpm contract:emit`, lalu
`pnpm exec prisma db update --dry-run` untuk meninjau, baru `pnpm db:update`.

## Batasan yang diketahui

**Baris hantu `PENDING` kalau proses API mati di antara INSERT dan enqueue.** Redis yang mati sudah
tertangani: pengantrean gagal cepat, job ditandai `FAILED`, client menerima `503`. Yang tidak bisa
ditangani adalah kematian proses API tepat di celah itu — tidak ada `catch` yang sempat berjalan,
dan barisnya tertinggal `PENDING` tanpa padanan di Redis. Yang menyembuhkan ini adalah sweeper
pemulihan (meng-enqueue ulang `PENDING` yang tua) atau pola outbox; keduanya sengaja belum dipasang.

**Pemulihan job yang nyangkut memakan sekitar satu menit.** Kalau worker mati di tengah pekerjaan,
job tetap `PROCESSING` sampai BullMQ mendeteksinya sebagai *stalled* dan mengirimkannya ke worker
lain. Terukur ~86 detik dari worker dibunuh sampai `COMPLETED` (deteksi stalled + pipeline diulang
dari langkah pertama). Selama itu client hanya melihat `PROCESSING`.

**Tidak ada autentikasi, rate limit, atau batas biaya.** Satu permintaan bisa memicu tiga panggilan
model atas materi 20.000 karakter. Jangan dipaparkan ke publik apa adanya.

**Tidak ada test otomatis.** `pnpm demo` adalah bukti end-to-end, bukan test suite; ia memanggil
model sungguhan sehingga tidak cocok untuk CI. Langkah 4 pipeline (`assemble-guide`) adalah bagian
yang paling layak diberi unit test lebih dulu karena murni deterministik.

**Build TypeScript sengaja tidak disediakan.** `tsconfig.json` memakai `noEmit`; jalur yang
didukung adalah `tsx`. Kompilasi ke `dist/` butuh penyesuaian resolusi modul yang belum dikerjakan.
