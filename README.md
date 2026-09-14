# Study Guide Pipeline API

An asynchronous API that turns **raw study material** into a **structured study guide**:
explained concepts together with comprehension questions.

The client submits source text and the API answers immediately with a job ID. A separate worker
runs a four-step pipeline with real model calls, then stores the result in PostgreSQL to be
fetched later.

The domain language lives in [CONTEXT.md](./CONTEXT.md); decisions that are not obvious from the
code are explained in [docs/adr/](./docs/adr/); the full test scenarios with their real results are
in [docs/TEST-CASES.md](./docs/TEST-CASES.md).

Two diagrams explain this system faster than prose does — open the files in a browser:

| Diagram | Answers |
| --- | --- |
| [docs/diagrams/architecture.html](./docs/diagrams/architecture.html) | Which components exist and how they connect |
| [docs/diagrams/happy-flow.html](./docs/diagrams/happy-flow.html) | What happens, in order, from `POST /jobs` to reading the guide |

## Setup

About 5 minutes, once.

### Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | **22.18+** | `.nvmrc` points at 22.22.2. Check this first — see the note below |
| pnpm | 11.22+ | `package.json` downloads it itself through `devEngines` when needed |
| Docker + Compose | any current version | Only for PostgreSQL and Redis; the API and worker run on your machine |
| Model API key | — | Any OpenAI-compatible provider (OpenRouter, OpenAI, etc.) |

> **Check your Node version before anything else.** On Node 20, `pnpm` **fails before it ever
> touches this project**, with `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`.
> The message points at pnpm rather than at the Node version, so it is easily mistaken for a broken
> pnpm installation.
>
> ```bash
> nvm use          # reads .nvmrc
> node -v          # must be v22.18.0 or newer
> ```

### Steps

```bash
# 1. Dependencies
pnpm install

# 2. Configuration — fill in OPENAI_API_KEY, and OPENAI_BASE_URL if not official OpenAI
cp .env.example .env

# 3. PostgreSQL + Redis
docker compose up -d

# 4. The Prisma contract (types + runtime metadata from prisma/schema.prisma)
pnpm contract:emit

# 5. Create the tables
pnpm db:init
```

Steps 4 and 5 are safe to repeat: `db:init` on an existing database applies zero operations and
still succeeds, so there is nothing to fear about running it twice.

The host ports are deliberately different from the other projects in the same folder
(`hono-prisma-bullmq` uses 55432/6380/3000, `feedback-pipeline-api` uses 55433/6381/3000), so all
three can be alive at once:

| Service | Host | Container |
| --- | --- | --- |
| PostgreSQL | `localhost:55434` | `5432` |
| Redis | `localhost:6382` | `6379` |
| API | `localhost:3100` | — |

### Running it

Two processes, two terminals:

```bash
pnpm dev          # terminal 1 — API on :3100
pnpm worker:dev   # terminal 2 — worker
```

Both validate the environment at boot and **refuse to start** if anything is missing, rather than
failing silently halfway through a job.

### Confirming the setup really worked

```bash
pnpm db:verify                      # "Database schema satisfies contract"
curl localhost:3100/health          # {"ok":true}
pnpm happy-flow                     # 15 assertions pass, ~25 seconds
```

`pnpm happy-flow` is the strongest check: it genuinely calls the model, writes to the database, and
reads the result back. If this is green, the whole chain works.

### When something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| `pnpm` fails with `node:sqlite` | Node below 22 | `nvm use`, then try again |
| Boot throws `Invalid environment configuration` | `.env` is incomplete | Fill in the variables the message names |
| Every endpoint that touches the database answers `500` | The containers are down (Docker restart, machine reboot) | `docker ps` to confirm, then `docker compose up -d` |
| `POST /jobs` answers `503` | Redis is down | `docker compose up -d` — `GET` reads keep working throughout |
| A job sits at `PENDING` | The worker is not running | Start `pnpm worker:dev` — the reconciler re-enqueues anything the queue lost within a minute |
| `docker compose up -d` hangs with no output at all | It is trying to pull images from the registry | If the `postgres:16` and `redis:7` images are already local: `docker compose up -d --pull never` |

After changing `prisma/schema.prisma`: `pnpm contract:emit`, then
`pnpm exec prisma db update --dry-run` to review, and only then `pnpm db:update`.

## Request flow

```text
Client                        API                          Worker
  |                            |                              |
  |-- POST /jobs ------------->|                              |
  |                            |-- store StudyJob PENDING      |
  |                            |-- enqueue { studyJobId } ---->|
  |<-- 202 + job ID -----------|                              |
  |                            |                    PROCESSING
  |                            |                    1 extract concepts  (model)
  |                            |                    2 explain concepts  (model)
  |                            |                    3 generate quiz     (model)
  |                            |                    4 assemble+validate (TypeScript)
  |                            |                    one transaction -> COMPLETED
  |-- GET /jobs/:id ---------->|                              |
  |<-- the stored guide -------|                              |
```

The queue is named `study-guide-queue` and its task is `generate-study-guide`. The queue payload
carries only `{ studyJobId }` — PostgreSQL remains the single source of truth for the source text,
which is also why recovery is scanned from PostgreSQL and not from Redis.

## Pipeline

Step 1 pulls concepts **only** from the source text and gives each concept a `slug`. Steps 2 and 3
must return that slug, and step 4 matches on it rather than relying on array order. Step 4 never
calls the model; that is where completeness is enforced. The reasoning is in
[ADR-0003](./docs/adr/0003-concepts-tied-by-slug-across-steps.md).

The number of concepts follows the density of the material (2–12), with 1–3 questions per concept.
Thin material produces a thin guide; material that teaches nothing produces a `FAILED` job.

## Endpoints

| Endpoint | Responsibility | Response |
| --- | --- | --- |
| `POST /jobs` | Validate the material and enqueue the work | `202` · job ID + status |
| `GET /jobs` | Paginated job list together with stored guides | `200` · `{ jobs, nextCursor }` |
| `GET /jobs/:id` | The status and guide of one job | `200` · the job, or `404` |
| `GET /health` | Liveness check for the demo script | `200` |

### POST /jobs

```bash
curl -i -X POST http://localhost:3100/jobs \
  -H 'Content-Type: application/json' \
  -d '{"sourceText":"<material, 500-20000 characters>","level":"intermediate","language":"en"}'
```

`level` — `beginner` (default) | `intermediate` | `advanced`. `language` — `id` (default) | `en`;
it selects the language the guide is *written in*, not the language of the source material.
Material below 500 or above 20,000 characters is rejected with `400`.

A `503` means the queue refused the work; the job is marked `FAILED` and will never be processed.
This is deliberate: better to refuse openly than to answer `202` for work that will never run.
Enqueueing is bounded to 5 seconds, and the API keeps serving reads even when Redis is down — see
[ADR-0005](./docs/adr/0005-separate-redis-connections-for-producer-and-worker.md).

### GET /jobs/:id

```json
{
  "id": "6d2e5223-01c7-4203-9ed1-d392a94f38f6",
  "status": "COMPLETED",
  "level": "intermediate",
  "language": "en",
  "createdAt": "2026-09-12T13:12:44.031Z",
  "completedAt": "2026-09-12T13:13:08.116Z",
  "failureReason": null,
  "guide": {
    "concepts": [
      {
        "id": "…",
        "order": 1,
        "title": "The call stack and being single-threaded",
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

`guide` stays `null` right up until the status is `COMPLETED` — no half-finished guide is ever
visible to a client, because the result is written in a single transaction
([ADR-0002](./docs/adr/0002-study-guide-written-atomically.md)). `sourceText` is never returned:
the client just sent it, and its size would make polling expensive.

### GET /jobs

```bash
curl 'http://localhost:3100/jobs?limit=20'
```

Ordered by `createdAt` descending, `limit` at most 50. Continue to the next page with
`?cursor=<nextCursor>`.

## Job status

| Status | Meaning |
| --- | --- |
| `PENDING` | Stored, not yet touched by a worker. Normally queued too — see the reconciler below |
| `PROCESSING` | A worker is running the pipeline (including while retrying) |
| `COMPLETED` | The guide is stored whole |
| `FAILED` | No guide will arrive; zero results stored, `failureReason` says why |

Status only moves forward. `COMPLETED` and `FAILED` are final, so a client may stop polling the
moment it sees either.

**Transient failures** (network, 429, a 5xx at the model provider) are retried up to three times
with exponential backoff, and the status stays `PROCESSING` throughout. **Permanent failures** —
material that carries no teachable concepts — go straight to `FAILED` with no retry.
See [ADR-0001](./docs/adr/0001-classifying-permanent-vs-transient-failures.md).

A third origin has nothing to do with the pipeline: a job the queue lost, which the **reconciler**
closes as abandoned. `failureReason` is what separates the three.

## The reconciler

Accepting a job is two writes — PostgreSQL commits the row, then Redis receives a pointer — and
nothing binds them. A process that dies in that gap leaves a row `PENDING` that no worker will ever
see, because BullMQ's own recovery is driven from Redis and Redis has no record of the job.

So recovery is scanned from PostgreSQL instead. Every 60 seconds the worker sweeps rows that have
been `PENDING` or `PROCESSING` for over 2 minutes, asks Redis what it holds, and acts on the answer:

| Redis says | `PENDING` | `PROCESSING` |
| --- | --- | --- |
| `active` / `waiting` / `delayed` | leave alone — genuinely in flight | leave alone |
| `unknown` | **re-enqueue**, however old it is | **close** as abandoned |
| `completed` / `failed` | **close** as abandoned | **close** as abandoned |

Age never condemns a job: it only decides when a row is worth a question. Redis authorises every
action — a threshold could not, because ordinary jobs here have taken up to 243 seconds end to end.
And asking is not optional: `queue.add` deduplicates on the *existence* of the job hash, so a job
left behind in Redis silently swallows a re-add. The reasoning is in
[ADR-0006](./docs/adr/0006-recovering-study-jobs-the-queue-has-lost.md).

## Stack

| Tool | Role |
| --- | --- |
| Hono + Node.js 22 | HTTP server on port `3100` |
| Zod | Request validation, model output schemas, and environment validation |
| Prisma 8 (Prisma Next) | Typed queries, CHECK-backed enums, relations, transactions |
| PostgreSQL 16 | Stores StudyJob, Concept, QuizQuestion |
| BullMQ 6 + Redis 7 | The background work queue |
| Anvia (`@anvia/core`, `@anvia/openai`) | Stepped pipeline + structured output |
| temporal-polyfill | The global `Temporal` that Prisma 8's time codec needs |

## Full-flow demo

```bash
pnpm demo
```

The script starts and stops the worker + API itself, then runs six steps: it submits a real lecture
transcript, waits for `COMPLETED`, lists the jobs, reads one guide, submits unprocessable material
to show the `FAILED` path along with a `404` for an unknown ID, and finally **stops and restarts
the API** to prove the stored guide is identical afterwards. The response artefacts are left behind
in `.demo/`.

The permanent-failure path uses `scripts/fixtures/source-noise.txt` (a sales receipt). That depends
on the model's judgement: if the model one day forces two concepts out of a receipt, the script
reports it instead of failing.

## Testing it yourself

The success path has its own assertion-backed test:

```bash
pnpm happy-flow
```

One piece of material runs through the whole pipeline, then 15 assertions check every guarantee
above — `202` without waiting, `guide` null until `COMPLETED`, concepts in order, zero orphaned
questions, and a concept count in the database equal to the one the API returns. The steps line up
with the happy flow diagram.

[docs/TEST-CASES.md](./docs/TEST-CASES.md) holds 33 scenarios with copy-ready commands and expected
results — including the ones `pnpm demo` does not cover: cursor pagination, transient retries, a
dead Redis, a worker killed mid-work, a job that never reached the queue, database constraints, and
resilience against prompt injection. The figures in the "measured results" section come from real runs, not estimates.

The test material lives in `scripts/fixtures/`:

| File | Contents | Tests |
| --- | --- | --- |
| `source-rich.txt` | Event loop lecture transcript, 2,403 characters | The success path |
| `source-thin.txt` | `let`/`const` notes, 778 characters, two ideas | Thin but legitimate material |
| `source-noise.txt` | A sales receipt, zero ideas | Permanent failure |
| `source-injection.txt` | A legitimate transcript + hijacking instructions | Prompt injection resilience |

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` / `pnpm worker:dev` | API and worker with file watching |
| `pnpm start` / `pnpm worker:start` | A single run without watching |
| `pnpm contract:emit` | Regenerate the Prisma contract after a schema change |
| `pnpm db:init` / `pnpm db:update` | Apply the schema to the database |
| `pnpm db:verify` | Match the database against the contract |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm demo` | The full-flow demonstration |
| `pnpm happy-flow` | The assertion-backed test for the success path (TC-HF) |

## Known limitations

**Recovery is eventual, not immediate.** A job the queue lost is found by the next sweep, so up to
about a minute passes before anything happens — and during that minute `PENDING` is ambiguous: it
may mean "queued" or "lost and not yet noticed". That ambiguity was accepted deliberately rather
than split into two client-visible statuses that would demand the same action from a client.

**Recovering a stuck job takes about a minute.** If a worker dies mid-work, the job stays
`PROCESSING` until BullMQ detects it as *stalled* and hands it to another worker. Measured at ~86
seconds from killing the worker to `COMPLETED` (stalled detection + the pipeline rerun from the
first step). Throughout that, a client sees only `PROCESSING`. A job that stalls **twice** exhausts
`maxStalledCount` and is dropped by BullMQ without the processor ever running; that one is closed by
the reconciler rather than retried, because how far the dead worker got is unknowable.

**A `PENDING` row inserted straight into PostgreSQL is real work.** The reconciler cannot tell it
apart from a job the API failed to enqueue, so tests that insert rows by hand have to clean up after
themselves.

**No authentication, rate limiting, or cost ceiling.** A single request can trigger three model
calls over 20,000 characters of material. Do not expose this publicly as it stands.

**No automated tests.** `pnpm demo` and [docs/TEST-CASES.md](./docs/TEST-CASES.md) are end-to-end
evidence run by a human, not a test suite; both call a real model, which makes them unsuitable for
CI. Step 4 of the pipeline (`assemble-guide`) is the part most worth unit testing first because it
is purely deterministic — it never touches the network at all.

**No TypeScript build is provided, deliberately.** `tsconfig.json` uses `noEmit`; the supported
path is `tsx`. Compiling to `dist/` needs module resolution work that has not been done.
