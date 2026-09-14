# 5. Separate Redis connections for the producer and the worker

Date: 2026-09-13

## Status

Accepted

## Context

The API and the worker originally shared one and the same Redis connection configuration object,
with `maxRetriesPerRequest: null`. BullMQ requires that value for a Worker: the blocking command a
Worker uses to wait for work must be allowed to wait indefinitely.

But the producer's need is the exact opposite, and making the two identical erased a guarantee an
earlier ADR had established: the router wraps enqueueing in a `try/catch` so a Study Job that fails
to enqueue is marked `FAILED` and the client receives a `503` rather than a `202` that lies.

Testing showed the guarantee never held. With Redis shut down, `POST /jobs` did not answer `503`;
the request hung until the client gave up after 30 seconds, and the row was left `PENDING` with no
reason. With `maxRetriesPerRequest: null`, an ioredis command never gives up, so the router's
`catch` never ran.

Setting `enableOfflineQueue: false` cures the "Redis died after having been connected" case, but
not "Redis was never connected since the process started": there BullMQ waits for the connection to
be ready before sending any command at all, and nothing bounds that wait.

## Decision

The producer and the worker use different connection configurations, each matched to its own need.

The worker keeps `maxRetriesPerRequest: null`. The producer uses `enableOfflineQueue: false`,
`maxRetriesPerRequest: 3`, and a `commandTimeout`, so commands fail instead of waiting.

Because even that does not close the never-established-connection case, enqueueing is wrapped in an
explicit timeout (`enqueueStudyGuideJob`, 5 seconds). Past that, enqueueing counts as failed.

A consequence of the timeout: a late command can still reach Redis after the Study Job has been
marked `FAILED`. So the worker refuses to work on a job whose status is already final — `COMPLETED`
or `FAILED` alike — following the "status only moves forward" rule in CONTEXT.md.

The API still starts even when Redis is down. The connection is warmed up at boot with a timeout,
and a failure there is only logged as a warning: reads stay useful, and writes reject honestly.

## Consequences

`POST /jobs` now answers `503` within tens of milliseconds when Redis dies after connecting, and
within five seconds when Redis never connected. Its Study Job is `FAILED` with a reason that names
the cause, and `GET /jobs` keeps serving.

The price is two connection configurations that have to be understood as a pair: copying the
worker's values over to the producer would silently bring hanging requests back. The comments in
`src/worker/config.ts` state the reason on both sides.

The five-second timeout is a chosen number, not a measured one. If Redis ever legitimately takes
longer to accept a single command, that number is the first thing to revisit.
