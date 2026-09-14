# 2. The Study Guide is written atomically

Date: 2026-09-12

## Status

Accepted

## Context

The pipeline produces Concepts in its second step and Quiz Questions in its third. Saving each
result as soon as it is available is a reasonable choice: progress is visible, and work already
finished is not thrown away if a later step fails.

But the worker runs under retries. A Study Job that fails transiently in the third step retries
**from the first step**, and finds the Concepts from the previous attempt already in the database.
Without special handling, the second attempt duplicates the Concepts.

A second problem: `GET /jobs/:id` must return a `null` result while nothing is ready. If Concepts
are already stored while Quiz Questions are not, "ready" becomes a graded state that has to be
defined and explained, and a client can read a guide without questions and not know it is
unfinished.

## Decision

The pipeline runs entirely in memory. No intermediate result touches the database.

Once all four steps are done, the entire Study Guide — every Concept, every Quiz Question, and the
status change to `COMPLETED` — is written inside a single `db.transaction(...)`. That transaction
commits or nothing does.

A failed Study Job therefore always has zero result rows, so a retry starts from a clean state with
nothing to clean up first.

## Consequences

Retries are idempotent without any idempotency code: there is no partial write to duplicate.

`guide: null` has exactly one meaning — not `COMPLETED` yet — so a client need only check the
status.

The price is that work from steps that already succeeded is discarded on every retry; a transient
failure in the third step pays for the first and second steps' tokens all over again. For a
three-model-call pipeline that cost is acceptable; if the steps grow in number or become much more
expensive, this is the first decision to revisit.

Another consequence: there is no per-step progress to show a client. A running Study Job says only
`PROCESSING`.
