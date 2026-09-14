#!/usr/bin/env bash
#
# TC-HF — happy flow end-to-end, dengan assersi.
#
# Menjalankan satu materi belajar melewati seluruh jalur sukses dan memeriksa
# tiap jaminan yang dijanjikan README: 202 tanpa menunggu, guide null sampai
# COMPLETED, konsep berurutan, soal menunjuk konsep yang sah, dan hasilnya
# benar-benar ada di PostgreSQL.
#
# Langkahnya sejajar dengan docs/diagrams/happy-flow.html.
#
# Prasyarat: docker compose up -d, lalu `pnpm dev` dan `pnpm worker:dev` hidup.

set -u

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

API="http://localhost:${PORT:-3100}"

if ! curl -fsS --max-time 3 "$API/health" >/dev/null 2>&1; then
  echo "API tidak merespons di $API — jalankan 'pnpm dev' lebih dulu." >&2
  exit 1
fi

pick() { node scripts/json.cjs "$1"; }
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
chk() { [ "$2" = "$3" ] && ok "$1 ($2)" || no "$1 — dapat '$2', harap '$3'"; }

printf '\033[1mTC-HF · Happy flow\033[0m — %s\n\n' "$API"

echo "[1] POST /jobs — mengantre materi"
node -e 'const fs=require("node:fs");fs.writeFileSync("/tmp/hf-req.json",JSON.stringify({
  sourceText: fs.readFileSync("scripts/fixtures/source-rich.txt","utf8"),
  level:"intermediate", language:"id"}))'
RES=$(curl -sS -w '\n%{http_code}' -X POST "$API/jobs" -H 'Content-Type: application/json' --data-binary @/tmp/hf-req.json)
CODE=$(printf '%s' "$RES" | tail -1); BODY=$(printf '%s' "$RES" | sed '$d')
chk "kode 202 Accepted" "$CODE" "202"
JOB=$(printf '%s' "$BODY" | pick job.id)
chk "status awal PENDING" "$(printf '%s' "$BODY" | pick job.status)" "PENDING"
chk "sourceText tidak dikembalikan" "$(printf '%s' "$BODY" | pick job.sourceText)" ""
echo "      job $JOB"

echo "[2] Baris tersimpan sebelum worker selesai"
DBST=$(docker exec -i studyguide-postgres psql -U studyguide -d studyguide -tAc \
  "select status from \"studyJob\" where id='$JOB'" 2>/dev/null)
case "$DBST" in
  PENDING|PROCESSING) ok "baris ada di PostgreSQL ($DBST)" ;;
  *) no "status di database '$DBST'" ;;
esac

echo "[3] guide bernilai null selama belum COMPLETED"
EARLY=$(curl -sS "$API/jobs/$JOB")
if [ "$(printf '%s' "$EARLY" | pick status)" != "COMPLETED" ]; then
  chk "guide masih null" "$(printf '%s' "$EARLY" | pick guide)" ""
else
  ok "job selesai lebih cepat dari pemeriksaan ini"
fi

echo "[4] Menunggu pipeline empat langkah"
T0=$(date +%s); LAST=""; ST=""
for _ in $(seq 1 90); do
  ST=$(curl -sS "$API/jobs/$JOB" | pick status)
  [ "$ST" != "$LAST" ] && { echo "      t+$(( $(date +%s) - T0 ))s  $ST"; LAST="$ST"; }
  case "$ST" in COMPLETED|FAILED) break ;; esac
  sleep 2
done
chk "status akhir COMPLETED" "$ST" "COMPLETED"

echo "[5] Struktur guide konsisten"
curl -sS "$API/jobs/$JOB" -o /tmp/hf-guide.json
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/hf-guide.json","utf8"));
const g = d.guide;
const ids = new Set(g ? g.concepts.map(c => c.id) : []);
const hasil = [
  ["guide terisi",             g ? "ya" : "tidak", "ya"],
  ["failureReason kosong",     d.failureReason === null ? "ya" : "tidak", "ya"],
  ["completedAt terisi",       d.completedAt ? "ya" : "tidak", "ya"],
  ["jumlah konsep minimal 2",  g && g.concepts.length >= 2 ? "ya" : "tidak", "ya"],
  ["order berurutan dari 1",   g && g.concepts.every((c,i) => c.order === i+1) ? "ya" : "tidak", "ya"],
  ["soal yatim",               g ? String(g.quiz.filter(q => !ids.has(q.conceptId)).length) : "-", "0"],
  ["tiap konsep punya soal",   g && g.concepts.every(c => g.quiz.some(q => q.conceptId === c.id)) ? "ya" : "tidak", "ya"],
];
require("fs").writeFileSync("/tmp/hf-checks.json", JSON.stringify(hasil));
console.log("      " + g.concepts.length + " konsep, " + g.quiz.length + " soal");
'
node -e 'JSON.parse(require("fs").readFileSync("/tmp/hf-checks.json","utf8"))
  .forEach(([n,a,e]) => console.log((a===e ? "  PASS  " : "  FAIL  ") + n + " (" + a + ")"))'
INLINE_FAIL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/hf-checks.json","utf8")).filter(([n,a,e])=>a!==e).length)')
pass=$((pass + 7 - INLINE_FAIL)); fail=$((fail + INLINE_FAIL))

echo "[6] Hasil ada di PostgreSQL, bukan hanya di memori proses"
NC=$(docker exec -i studyguide-postgres psql -U studyguide -d studyguide -tAc \
  "select count(*) from concept where \"studyJobId\"='$JOB'" 2>/dev/null)
NG=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/hf-guide.json","utf8")).guide.concepts.length)')
chk "jumlah konsep database = respons" "$NC" "$NG"

echo "[7] Job muncul di GET /jobs beserta guide-nya"
FOUND=$(curl -sS "$API/jobs?limit=20" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0,"utf8"));
  const j = d.jobs.find(x => x.id === process.argv[1]);
  console.log(j && j.guide ? "ya" : "tidak");' "$JOB")
chk "ada di daftar dengan guide" "$FOUND" "ya"

echo
if [ "$fail" = "0" ]; then
  printf '\033[32m  %s assersi lulus, 0 gagal.\033[0m\n' "$pass"
else
  printf '\033[31m  %s lulus, %s GAGAL.\033[0m\n' "$pass" "$fail"
fi
[ "$fail" = "0" ]
