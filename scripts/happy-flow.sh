#!/usr/bin/env bash
#
# TC-HF — end-to-end happy flow, with assertions.
#
# Runs one piece of study material through the whole success path and checks
# every guarantee the README promises: 202 without waiting, a null guide until
# COMPLETED, concepts in order, questions pointing at valid concepts, and the
# results genuinely present in PostgreSQL.
#
# The steps line up with docs/diagrams/happy-flow.html.
#
# Prerequisites: docker compose up -d, then `pnpm dev` and `pnpm worker:dev`
# running.

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
  echo "The API is not responding at $API — run 'pnpm dev' first." >&2
  exit 1
fi

pick() { node scripts/json.cjs "$1"; }
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
no() { echo "  FAIL  $1"; fail=$((fail+1)); }
chk() { [ "$2" = "$3" ] && ok "$1 ($2)" || no "$1 — got '$2', want '$3'"; }

printf '\033[1mTC-HF · Happy flow\033[0m — %s\n\n' "$API"

echo "[1] POST /jobs — enqueueing the material"
node -e 'const fs=require("node:fs");fs.writeFileSync("/tmp/hf-req.json",JSON.stringify({
  sourceText: fs.readFileSync("scripts/fixtures/source-rich.txt","utf8"),
  level:"intermediate", language:"en"}))'
RES=$(curl -sS -w '\n%{http_code}' -X POST "$API/jobs" -H 'Content-Type: application/json' --data-binary @/tmp/hf-req.json)
CODE=$(printf '%s' "$RES" | tail -1); BODY=$(printf '%s' "$RES" | sed '$d')
chk "202 Accepted status code" "$CODE" "202"
JOB=$(printf '%s' "$BODY" | pick job.id)
chk "initial status PENDING" "$(printf '%s' "$BODY" | pick job.status)" "PENDING"
chk "sourceText is not returned" "$(printf '%s' "$BODY" | pick job.sourceText)" ""
echo "      job $JOB"

echo "[2] The row is stored before the worker finishes"
DBST=$(docker exec -i studyguide-postgres psql -U studyguide -d studyguide -tAc \
  "select status from \"studyJob\" where id='$JOB'" 2>/dev/null)
case "$DBST" in
  PENDING|PROCESSING) ok "row present in PostgreSQL ($DBST)" ;;
  *) no "database status '$DBST'" ;;
esac

echo "[3] guide stays null while the job is not COMPLETED"
EARLY=$(curl -sS "$API/jobs/$JOB")
if [ "$(printf '%s' "$EARLY" | pick status)" != "COMPLETED" ]; then
  chk "guide is still null" "$(printf '%s' "$EARLY" | pick guide)" ""
else
  ok "the job finished faster than this check"
fi

echo "[4] Waiting for the four-step pipeline"
T0=$(date +%s); LAST=""; ST=""
for _ in $(seq 1 90); do
  ST=$(curl -sS "$API/jobs/$JOB" | pick status)
  [ "$ST" != "$LAST" ] && { echo "      t+$(( $(date +%s) - T0 ))s  $ST"; LAST="$ST"; }
  case "$ST" in COMPLETED|FAILED) break ;; esac
  sleep 2
done
chk "final status COMPLETED" "$ST" "COMPLETED"

echo "[5] The guide structure is consistent"
curl -sS "$API/jobs/$JOB" -o /tmp/hf-guide.json
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/hf-guide.json","utf8"));
const g = d.guide;
const ids = new Set(g ? g.concepts.map(c => c.id) : []);
const results = [
  ["guide is populated",        g ? "yes" : "no", "yes"],
  ["failureReason is empty",    d.failureReason === null ? "yes" : "no", "yes"],
  ["completedAt is populated",  d.completedAt ? "yes" : "no", "yes"],
  ["at least 2 concepts",       g && g.concepts.length >= 2 ? "yes" : "no", "yes"],
  ["order runs from 1 upwards", g && g.concepts.every((c,i) => c.order === i+1) ? "yes" : "no", "yes"],
  ["orphaned questions",        g ? String(g.quiz.filter(q => !ids.has(q.conceptId)).length) : "-", "0"],
  ["every concept has a question", g && g.concepts.every(c => g.quiz.some(q => q.conceptId === c.id)) ? "yes" : "no", "yes"],
];
require("fs").writeFileSync("/tmp/hf-checks.json", JSON.stringify(results));
console.log("      " + g.concepts.length + " concepts, " + g.quiz.length + " questions");
'
node -e 'JSON.parse(require("fs").readFileSync("/tmp/hf-checks.json","utf8"))
  .forEach(([n,a,e]) => console.log((a===e ? "  PASS  " : "  FAIL  ") + n + " (" + a + ")"))'
INLINE_FAIL=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/hf-checks.json","utf8")).filter(([n,a,e])=>a!==e).length)')
pass=$((pass + 7 - INLINE_FAIL)); fail=$((fail + INLINE_FAIL))

echo "[6] The results live in PostgreSQL, not just in process memory"
NC=$(docker exec -i studyguide-postgres psql -U studyguide -d studyguide -tAc \
  "select count(*) from concept where \"studyJobId\"='$JOB'" 2>/dev/null)
NG=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/hf-guide.json","utf8")).guide.concepts.length)')
chk "concept count in database = response" "$NC" "$NG"

echo "[7] The job shows up in GET /jobs together with its guide"
FOUND=$(curl -sS "$API/jobs?limit=20" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0,"utf8"));
  const j = d.jobs.find(x => x.id === process.argv[1]);
  console.log(j && j.guide ? "yes" : "no");' "$JOB")
chk "present in the list with a guide" "$FOUND" "yes"

echo
if [ "$fail" = "0" ]; then
  printf '\033[32m  %s assertions passed, 0 failed.\033[0m\n' "$pass"
else
  printf '\033[31m  %s passed, %s FAILED.\033[0m\n' "$pass" "$fail"
fi
[ "$fail" = "0" ]
