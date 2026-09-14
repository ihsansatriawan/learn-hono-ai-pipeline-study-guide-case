# 1. Classifying permanent vs transient failures

Date: 2026-09-12

## Status

Accepted

## Context

The worker runs a four-step pipeline, three steps of which call a language model. Failures there
come from two different worlds:

- **Transient** — a dropped network, a 429 rate limit, a 5xx outage at the model provider. The very
  same work will most likely succeed if repeated a few seconds later.
- **Permanent** — the Source Text does not carry enough material to form a Study Guide. Repeating
  identical work produces an identical failure.

BullMQ knows nothing of this distinction; it only sees an exception. If every failure is treated
alike, an input that plainly cannot be processed still burns three attempts and tokens on each of
them, and demonstrating a failure means waiting out the backoff.

There is a second problem: when to write the `FAILED` status. Writing `FAILED` inside the `catch`
and then rethrowing means a Study Job that eventually succeeds is briefly seen as `FAILED` by a
polling client.

## Decision

The worker separates the two failure classes by error type.

Permanent failures are represented by their own error class. When one is caught, the worker writes
`FAILED` together with its reason and **returns normally** — it does not throw, so BullMQ considers
the work done and does not retry.

Transient failures are rethrown. BullMQ retries up to three attempts with exponential backoff.
Throughout that, the status stays `PROCESSING`. `FAILED` is only written on the last attempt, that
is when `job.attemptsMade + 1 >= job.opts.attempts`.

As a result, `FAILED` is always final: the status never moves backwards.

## Consequences

The status a client sees always moves monotonically forward, so a client may stop polling the
moment it sees `FAILED`.

An unprocessable input fails at once, with no tokens wasted and no backoff to wait out.

The price: the worker sometimes swallows an error instead of throwing it, and that is unusual — a
reader who does not know why will take it for a bug. Another consequence is that every new failure
class must be deliberately classified; an unrecognised failure is treated as transient, so a
misclassification costs pointless retries rather than lost work.
