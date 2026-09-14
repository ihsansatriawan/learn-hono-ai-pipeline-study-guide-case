# 6. Recovering Study Jobs the queue has lost

Date: 2026-09-14

## Status

Accepted

## Context

Accepting a Study Job is two writes, not one: PostgreSQL commits the row, then `queue.add` sends a
pointer to Redis. Nothing binds them. ADR-0005 closed the loud half of the gap — when Redis refuses
or times out, the router marks the row `FAILED` and answers `503`. What remains is the quiet half:
the API process dies between the commit and the add, or `markFailed` itself fails. The row is then
left `PENDING` with no `failureReason`, and no client ever learns that no answer is coming.

That is not hypothetical. The development database holds three such rows, the oldest two days old,
and `EXISTS bull:study-guide-queue:<id>` returns `0` for every one of them. BullMQ cannot find
them: its recovery machinery — the stalled check, retries, the delayed set — is driven from Redis
and can only recover jobs Redis knows about. These rows exist solely in PostgreSQL, which
`src/worker/queue.ts` already names as the source of truth.

`PROCESSING` has the mirror of the same hole. The worker writes `PROCESSING` before the pipeline
runs, so a process that dies mid-pipeline leaves the row claimed. BullMQ's stalled check redelivers
such a job once; `maxStalledCount` defaults to `1`, so a second stall moves it to `failed` **without
ever invoking the processor**. The worker's `catch` never runs, nothing writes `FAILED`, and there
is no `worker.on("failed")` listener to notice. The row stays `PROCESSING` forever.

Two measurements shaped what could be done about it.

**`queue.add` cannot be used blindly.** BullMQ 6.3.4, `addStandardJob-9.lua`:

```lua
if rcall("EXISTS", jobIdKey) == 1 then
    return handleDuplicatedJob(...)   -- returns; never pushes to wait
end
```

Deduplication by `jobId` keys on the *existence of the job hash*, not on the job still being in
flight. A job left behind in the `completed` or `failed` set — `removeOnFail` keeps 100 of them —
silently swallows the add and returns the old job. A reconciler that trusted `add` would log
success and change nothing.

**Age is not evidence.** End-to-end duration of the 22 `COMPLETED` jobs on hand: min 16.7s, avg
43.0s, p95 92.9s, max **243.2s**. The slowest came from a 2403-character Source Text, the same size
as the rows awaiting recovery — an ordinary input, not an outlier. Any age threshold small enough
to catch a stuck row quickly is also small enough to condemn a job that is still running.

## Decision

A **reconciler** runs in the worker process, sweeping PostgreSQL every 60 seconds for `PENDING` and
`PROCESSING` rows older than 2 minutes. For each one it asks Redis `getJobState(id)` and acts on the
answer:

| `getJobState` | `PENDING` | `PROCESSING` |
| --- | --- | --- |
| `active` / `waiting` / `delayed` / `prioritized` | leave alone | leave alone |
| `unknown` | **heal** — `enqueueStudyGuideJob` | **close** — `markFailed` |
| `completed` / `failed` | **close** — `markFailed` | **close** — `markFailed` |

Three properties follow from that table.

**Redis authorises every action, not the clock.** The age threshold decides only when it is worth
asking a question; it never decides a Study Job's fate. Getting the number wrong costs one `ZSCORE`,
not a killed job.

**Age never condemns.** A row nothing has started work on is re-queued however old it is. A worker
that was down for three hours heals everything on its first sweep instead of declaring it abandoned
for having been born at the wrong time.

**A claimed job is closed, not re-run.** `PROCESSING` means a worker took the job and then
disappeared with it. How far it got is unknowable, and `attempts: 3` plus the stalled check have
already spent the retries the system was willing to spend. Re-running it would pay for a full
pipeline blind.

Closing is safe to do: ADR-0002 writes concepts, questions and `COMPLETED` in one transaction, so a
row that is not `COMPLETED` provably has no Concept stored, and no half-built Study Guide is
discarded by writing `FAILED`.

Two supporting changes come with it:

- `saveStudyGuide` updates the status only when it is not already `FAILED`, and throws inside the
  transaction when no row matches, so concepts and questions roll back with it. This makes the
  "status only moves forward" rule enforced rather than merely documented — without it, a row the
  reconciler closed while its worker was in fact still alive would travel `FAILED` → `COMPLETED`.
- `CONTEXT.md` gains **Abandoned Study Job**; `FAILED` is redefined by outcome ("no Study Guide will
  arrive") rather than by mechanism ("the pipeline stopped"), with `failureReason` carrying the
  distinction.

## Considered options

**A transactional outbox table**, written in the same transaction as the Study Job and drained by a
relay. Rejected: the `studyJob` row already *is* the outbox record — `status = 'PENDING'` plus
`createdAt` carries exactly the same intent. A separate table would add a migration, a relay and a
cleanup policy to buy ordering and publish history that independent jobs have no use for.

**An `ACCEPTED` status**, promoted to `PENDING` only once `queue.add` succeeds, so `PENDING` would
mean "definitely queued". Rejected: `status` is returned verbatim to clients, and to a client the
two states demand exactly the same action — keep waiting. It moves internal complexity into the
public contract for a clarity only an operator benefits from.

**A `worker.on("failed")` listener** instead of sweeping `PROCESSING`. Rejected: the listener lives
in the worker process, and the scenario that strands rows is that process dying. It is a fire alarm
that burns down with the building. Worth adding for other cases; not a substitute.

**Healing stale `PROCESSING` rows** via `job.retry()` or `remove` + `add`. Rejected: it forces the
reconciler to manage BullMQ's internal states rather than merely read one, and `remove` on a job
that is genuinely `active` would pull work out from under a live worker.

## Consequences

Recovery is now scanned from the side that holds the truth. Any Study Job that reaches PostgreSQL
gets an answer eventually, whatever happens to Redis in between.

`FAILED` now carries two different origins. `failureReason` is the only thing that separates a
pipeline that stopped from a Study Job that never reached a worker, so it must stay specific.

The reconciler reads BullMQ's job-state vocabulary. That coupling is narrow — one read-only call —
but an upgrade that renames a state would break it quietly. The dedup assumption disproved above
was reached by reading the Lua; the same scepticism applies on every BullMQ upgrade.

Rows inserted straight into `studyJob` with status `PENDING` are now real work. `TC-D7` and `TC-E2`
do exactly that, and must clean up after themselves or use a Source Text the pipeline will reject.

The cost is one Redis read per stale row per sweep, which on a healthy system is zero.

As in ADR-0005, the numbers — 60 seconds, 2 minutes — are chosen, not measured. Unlike ADR-0005's
five-second timeout, they are no longer load-bearing: Redis, not the threshold, decides.
