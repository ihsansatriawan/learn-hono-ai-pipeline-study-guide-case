# Context — Study Guide Pipeline

An asynchronous API that turns **raw study material** into a **structured study guide**.
The client submits source text, the API accepts it and enqueues it, a worker processes it through
a layered pipeline, and the result is fetched later.

## Language

### Source Text
The raw study material the client submits — a book chapter, a lecture transcript, notes, a long
article. It is the only source of truth for the guide's content. The model may **not** add concepts
that are absent from the Source Text; if the material is thin, the guide is thin too.

### Study Job
One request to build a guide. It holds the Source Text, the learning preferences (level, language),
the processing status, and — when it fails — the reason. Created by the API, finished by the worker.
It is created, not edited: a client never modifies a Study Job.

### Concept
One teachable idea extracted from the Source Text. It has a title, an explanation, and a reason why
it matters. The order is meaningful — Concepts are sequenced to follow the learning path, not the
order in which they appear in the Source Text.

### Quiz Question
One comprehension question together with its answer, derived from a Concept's explanation. Every
Quiz Question points at the Concept it tests; a question without a valid Concept is discarded.

### Study Guide
The combined Concepts + Quiz Questions belonging to one Study Job. It is not a table of its own —
"Study Guide" is how we talk about the complete result of a single Study Job. A Study Guide exists
only in complete form: no half-finished guide is ever visible to a client.

### Study Job status
- `PENDING` — stored and queued, not yet touched by a worker.
- `PROCESSING` — a worker is running the pipeline.
- `COMPLETED` — the Study Guide is stored whole.
- `FAILED` — the pipeline stopped; zero results stored, reason recorded.

Status only moves forward; `COMPLETED` and `FAILED` are final.

### Grounding
The rule that every Concept and Quiz Question must come from the Source Text. The number of
Concepts follows the density of the material rather than a figure fixed in advance — thin material
produces a thin guide, and that is a correct result, not a failure.

### Unprocessable Source
A Source Text that does not carry enough material to form a Study Guide (fewer than two Concepts).
This is a **permanent** failure: repeating the same work will not change the outcome, so the Study
Job goes straight to `FAILED` with no retry. This differs from a **transient** failure (network,
rate limit, model provider outage), which is worth trying again.

### Retry
Another attempt at the same Study Job after a transient failure. Throughout the retries the status
stays `PROCESSING` — a client never sees a `FAILED` that later becomes `COMPLETED`. `FAILED` is
written only once there is nothing left to try.
