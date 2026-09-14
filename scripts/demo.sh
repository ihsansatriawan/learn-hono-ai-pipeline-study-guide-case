#!/usr/bin/env bash
#
# Demonstrasi alur penuh, sesuai poin 03 tugas:
#   start a job -> list jobs -> fetch one result -> handle a failed job
#   -> saved results must survive an API restart
#
# Prasyarat: `docker compose up -d`, `.env` terisi, kontrak sudah di-emit,
# database sudah di-init. Skrip ini menyalakan dan mematikan API + worker sendiri.

set -euo pipefail

cd "$(dirname "$0")/.."

DEMO_DIR=".demo"
mkdir -p "$DEMO_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PORT="${PORT:-3100}"
BASE="http://localhost:${PORT}"
POLL_TIMEOUT_SECONDS="${POLL_TIMEOUT_SECONDS:-240}"

API_PID=""
WORKER_PID=""

json() { node scripts/json.cjs "$1"; }

# Diagnostik selalu ke stderr: poll_until_final dipanggil di dalam $(...),
# dan stdout-nya harus berisi status saja.
step() { printf '\n\033[1m[%s] %s\033[0m\n' "$1" "$2" >&2; }
info() { printf '      %s\n' "$1" >&2; }
fail() { printf '\n\033[31mGAGAL: %s\033[0m\n' "$1" >&2; exit 1; }

# tsx menjalankan skripnya di proses ANAK. Mematikan induknya saja meninggalkan
# anak itu hidup sebagai worker yatim yang tetap menyambar job dari antrean —
# jadi anaknya harus ikut disasar.
kill_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.3
  done
  pkill -9 -P "$pid" 2>/dev/null || true
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  kill_pid "$API_PID"
  kill_pid "$WORKER_PID"
}
trap cleanup EXIT

# node_modules/.bin/tsx langsung: PID yang kita simpan adalah proses yang
# sebenarnya mendengarkan port, sehingga kill benar-benar mematikannya.
TSX="node_modules/.bin/tsx"

start_api() {
  "$TSX" src/index.ts >"$DEMO_DIR/api.log" 2>&1 &
  API_PID=$!
  for _ in $(seq 1 40); do
    if curl -fsS "$BASE/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  fail "API tidak merespons di $BASE. Lihat $DEMO_DIR/api.log"
}

stop_api() {
  kill_pid "$API_PID"
  for _ in $(seq 1 20); do
    curl -fsS "$BASE/health" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  fail "API tidak mau berhenti."
}

# Antre satu job dari berkas materi, kembalikan id-nya.
submit_job() {
  local file="$1" level="$2" language="$3" out="$4"
  node -e '
    const fs = require("node:fs");
    const body = {
      sourceText: fs.readFileSync(process.argv[1], "utf8"),
      level: process.argv[2],
      language: process.argv[3],
    };
    fs.writeFileSync(process.argv[4], JSON.stringify(body));
  ' "$file" "$level" "$language" "$DEMO_DIR/request.json"

  curl -fsS -X POST "$BASE/jobs" \
    -H 'Content-Type: application/json' \
    --data-binary "@$DEMO_DIR/request.json" >"$out"
}

# Polling sampai status final, cetak transisi yang terlihat.
poll_until_final() {
  local job_id="$1" out="$2"
  local waited=0 status="" last=""

  while [ "$waited" -lt "$POLL_TIMEOUT_SECONDS" ]; do
    curl -fsS "$BASE/jobs/$job_id" >"$out"
    status="$(json status <"$out")"

    if [ "$status" != "$last" ]; then
      info "status: $status (${waited}s)"
      last="$status"
    fi

    case "$status" in
      COMPLETED|FAILED) echo "$status"; return 0 ;;
    esac

    sleep 2
    waited=$((waited + 2))
  done

  fail "Job $job_id tidak selesai dalam ${POLL_TIMEOUT_SECONDS}s."
}

printf '\033[1mDemo Study Guide Pipeline API\033[0m — %s\n' "$BASE" >&2

step 0/6 "Menyalakan worker dan API"
"$TSX" src/worker/worker.ts >"$DEMO_DIR/worker.log" 2>&1 &
WORKER_PID=$!
start_api
info "worker pid $WORKER_PID, api pid $API_PID (log di $DEMO_DIR/)"

step 1/6 "POST /jobs — mengirim transkrip kuliah sungguhan"
submit_job scripts/fixtures/source-rich.txt intermediate id "$DEMO_DIR/created.json"
JOB_ID="$(json job.id <"$DEMO_DIR/created.json")"
[ -n "$JOB_ID" ] || fail "Tidak dapat job id. Isi respons: $(cat "$DEMO_DIR/created.json")"
info "202 Accepted — job $JOB_ID, status $(json job.status <"$DEMO_DIR/created.json")"

step 2/6 "Menunggu worker menyelesaikan pipeline"
STATUS="$(poll_until_final "$JOB_ID" "$DEMO_DIR/guide-before.json")"
if [ "$STATUS" != "COMPLETED" ]; then
  fail "Job utama berakhir '$STATUS': $(json failureReason <"$DEMO_DIR/guide-before.json")"
fi

step 3/6 "GET /jobs — daftar job berpaginasi"
curl -fsS "$BASE/jobs?limit=20" >"$DEMO_DIR/list.json"
node -e '
  const list = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(`      ${list.jobs.length} job, nextCursor=${list.nextCursor}`);
  for (const job of list.jobs) {
    const guide = job.guide ? `${job.guide.concepts.length} konsep / ${job.guide.quiz.length} soal` : "guide: null";
    console.log(`      - ${job.id}  ${job.status.padEnd(10)} ${guide}`);
  }
' "$DEMO_DIR/list.json"

step 4/6 "GET /jobs/:id — membaca satu study guide"
node -e '
  const job = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(`      ${job.guide.concepts.length} konsep, ${job.guide.quiz.length} soal, bahasa ${job.language}`);
  for (const c of job.guide.concepts) {
    console.log(`      ${String(c.order).padStart(2)}. ${c.title}`);
    console.log(`          ${c.explanation.slice(0, 110)}...`);
  }
  const q = job.guide.quiz[0];
  console.log(`      contoh soal [${q.difficulty}]: ${q.question}`);
  console.log(`      jawaban: ${q.answer.slice(0, 110)}...`);
' "$DEMO_DIR/guide-before.json"

step 5/6 "Job gagal — materi tanpa konsep yang bisa diajarkan"
submit_job scripts/fixtures/source-noise.txt beginner id "$DEMO_DIR/created-failed.json"
FAILED_ID="$(json job.id <"$DEMO_DIR/created-failed.json")"
info "202 Accepted — job $FAILED_ID (struk belanja, bukan materi belajar)"
FAILED_STATUS="$(poll_until_final "$FAILED_ID" "$DEMO_DIR/failed.json")"
if [ "$FAILED_STATUS" = "FAILED" ]; then
  info "failureReason: $(json failureReason <"$DEMO_DIR/failed.json")"
  GUIDE_VALUE="$(json guide <"$DEMO_DIR/failed.json")"
  info "guide: ${GUIDE_VALUE:-null} — nol hasil tersimpan, sesuai ADR-0002"
else
  info "CATATAN: model berhasil menemukan konsep dari struk; job berakhir $FAILED_STATUS."
  info "Jalur kegagalan permanen bergantung pada penilaian model — lihat README."
fi
# Tanpa -f: 404 di sini adalah hasil yang DIHARAPKAN, bukan kegagalan skrip.
NOT_FOUND_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/jobs/tidak-ada-job-ini")"
info "GET /jobs/id-yang-tidak-ada -> HTTP $NOT_FOUND_CODE"
[ "$NOT_FOUND_CODE" = "404" ] || fail "ID tidak dikenal seharusnya 404, dapat $NOT_FOUND_CODE"

step 6/6 "Restart API — membuktikan hasil selamat"
stop_api
info "API dimatikan (pid lama $API_PID)"
start_api
info "API dinyalakan ulang (pid baru $API_PID)"
curl -fsS "$BASE/jobs/$JOB_ID" >"$DEMO_DIR/guide-after.json"
node -e '
  const fs = require("node:fs");
  const before = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const after = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const same = JSON.stringify(before.guide) === JSON.stringify(after.guide);
  if (!same) {
    console.error("      Guide BERUBAH setelah restart.");
    process.exit(1);
  }
  console.log(`      Guide identik setelah restart: ${after.guide.concepts.length} konsep, ${after.guide.quiz.length} soal.`);
' "$DEMO_DIR/guide-before.json" "$DEMO_DIR/guide-after.json"

printf '\n\033[32mSelesai.\033[0m Artefak respons tersimpan di %s/\n' "$DEMO_DIR"
