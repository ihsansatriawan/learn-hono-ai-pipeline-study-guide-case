#!/usr/bin/env bash
#
# Full-flow demonstration, matching point 03 of the assignment:
#   start a job -> list jobs -> fetch one result -> handle a failed job
#   -> saved results must survive an API restart
#
# Prerequisites: `docker compose up -d`, a filled-in `.env`, the contract
# emitted, the database initialised. This script starts and stops the API +
# worker itself.

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

# Diagnostics always go to stderr: poll_until_final is called inside $(...),
# and its stdout must carry the status alone.
step() { printf '\n\033[1m[%s] %s\033[0m\n' "$1" "$2" >&2; }
info() { printf '      %s\n' "$1" >&2; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

# tsx runs the script in a CHILD process. Killing only the parent leaves that
# child alive as an orphaned worker that keeps grabbing jobs off the queue —
# so the child has to be targeted too.
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

# node_modules/.bin/tsx directly: the PID we keep is the process actually
# listening on the port, so kill really does stop it.
TSX="node_modules/.bin/tsx"

start_api() {
  "$TSX" src/index.ts >"$DEMO_DIR/api.log" 2>&1 &
  API_PID=$!
  for _ in $(seq 1 40); do
    if curl -fsS "$BASE/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  fail "The API is not responding at $BASE. See $DEMO_DIR/api.log"
}

stop_api() {
  kill_pid "$API_PID"
  for _ in $(seq 1 20); do
    curl -fsS "$BASE/health" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  fail "The API refuses to stop."
}

# Enqueue one job from a material file and return its id.
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

# Poll until the status is final, printing every transition seen.
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

  fail "Job $job_id did not finish within ${POLL_TIMEOUT_SECONDS}s."
}

printf '\033[1mStudy Guide Pipeline API demo\033[0m — %s\n' "$BASE" >&2

step 0/6 "Starting the worker and the API"
"$TSX" src/worker/worker.ts >"$DEMO_DIR/worker.log" 2>&1 &
WORKER_PID=$!
start_api
info "worker pid $WORKER_PID, api pid $API_PID (logs in $DEMO_DIR/)"

step 1/6 "POST /jobs — submitting a real lecture transcript"
submit_job scripts/fixtures/source-rich.txt intermediate en "$DEMO_DIR/created.json"
JOB_ID="$(json job.id <"$DEMO_DIR/created.json")"
[ -n "$JOB_ID" ] || fail "No job id returned. Response body: $(cat "$DEMO_DIR/created.json")"
info "202 Accepted — job $JOB_ID, status $(json job.status <"$DEMO_DIR/created.json")"

step 2/6 "Waiting for the worker to finish the pipeline"
STATUS="$(poll_until_final "$JOB_ID" "$DEMO_DIR/guide-before.json")"
if [ "$STATUS" != "COMPLETED" ]; then
  fail "The main job ended '$STATUS': $(json failureReason <"$DEMO_DIR/guide-before.json")"
fi

step 3/6 "GET /jobs — the paginated job list"
curl -fsS "$BASE/jobs?limit=20" >"$DEMO_DIR/list.json"
node -e '
  const list = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(`      ${list.jobs.length} jobs, nextCursor=${list.nextCursor}`);
  for (const job of list.jobs) {
    const guide = job.guide ? `${job.guide.concepts.length} concepts / ${job.guide.quiz.length} questions` : "guide: null";
    console.log(`      - ${job.id}  ${job.status.padEnd(10)} ${guide}`);
  }
' "$DEMO_DIR/list.json"

step 4/6 "GET /jobs/:id — reading a single study guide"
node -e '
  const job = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(`      ${job.guide.concepts.length} concepts, ${job.guide.quiz.length} questions, language ${job.language}`);
  for (const c of job.guide.concepts) {
    console.log(`      ${String(c.order).padStart(2)}. ${c.title}`);
    console.log(`          ${c.explanation.slice(0, 110)}...`);
  }
  const q = job.guide.quiz[0];
  console.log(`      sample question [${q.difficulty}]: ${q.question}`);
  console.log(`      answer: ${q.answer.slice(0, 110)}...`);
' "$DEMO_DIR/guide-before.json"

step 5/6 "A failed job — material with nothing teachable in it"
submit_job scripts/fixtures/source-noise.txt beginner en "$DEMO_DIR/created-failed.json"
FAILED_ID="$(json job.id <"$DEMO_DIR/created-failed.json")"
info "202 Accepted — job $FAILED_ID (a sales receipt, not study material)"
FAILED_STATUS="$(poll_until_final "$FAILED_ID" "$DEMO_DIR/failed.json")"
if [ "$FAILED_STATUS" = "FAILED" ]; then
  info "failureReason: $(json failureReason <"$DEMO_DIR/failed.json")"
  GUIDE_VALUE="$(json guide <"$DEMO_DIR/failed.json")"
  info "guide: ${GUIDE_VALUE:-null} — zero results stored, exactly as ADR-0002 requires"
else
  info "NOTE: the model did find concepts in the receipt; the job ended $FAILED_STATUS."
  info "The permanent-failure path depends on the model's judgement — see the README."
fi
# No -f here: a 404 is the EXPECTED outcome, not a script failure.
NOT_FOUND_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/jobs/no-such-job-here")"
info "GET /jobs/an-unknown-id -> HTTP $NOT_FOUND_CODE"
[ "$NOT_FOUND_CODE" = "404" ] || fail "An unknown id should give 404, got $NOT_FOUND_CODE"

step 6/6 "Restarting the API — proving the results survive"
stop_api
info "API stopped (old pid $API_PID)"
start_api
info "API restarted (new pid $API_PID)"
curl -fsS "$BASE/jobs/$JOB_ID" >"$DEMO_DIR/guide-after.json"
node -e '
  const fs = require("node:fs");
  const before = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const after = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const same = JSON.stringify(before.guide) === JSON.stringify(after.guide);
  if (!same) {
    console.error("      The guide CHANGED after the restart.");
    process.exit(1);
  }
  console.log(`      Guide identical after the restart: ${after.guide.concepts.length} concepts, ${after.guide.quiz.length} questions.`);
' "$DEMO_DIR/guide-before.json" "$DEMO_DIR/guide-after.json"

printf '\n\033[32mDone.\033[0m Response artefacts saved in %s/\n' "$DEMO_DIR"
