# 4. A Temporal polyfill for the time columns

Date: 2026-09-12

## Status

Accepted

## Context

Prisma 8 maps `DateTime` to the `pg/timestamptz-temporal@1` codec, which reads and writes the value
as a `Temporal.Instant` through the global `Temporal`. Node.js does not ship that global yet —
checked on Node 22.22 and 24.19, both `typeof Temporal === "undefined"`.

The effect is not merely a typing problem. Reading a single row that has a `DateTime` column throws
during decoding:

```
Codec 'pg/timestamptz-temporal@1' cannot decode a value because this runtime has
no global Temporal implementation.  (RUNTIME.TEMPORAL_UNAVAILABLE)
```

Which means every `StudyJob` read would fail, because `createdAt` is on every row. Prisma's own
error message offers two ways out: install a Temporal polyfill before the client is created, or
declare the columns with a `*String` codec so what is read and written is PostgreSQL's own text.

## Decision

Install `temporal-polyfill` and import its global variant as the **first import** in the module
that creates the database client (`src/utils/db.ts`). ESM module execution follows import order, so
the polyfill is in place before `postgres()` is ever called.

The time columns stay `DateTime`, and their values stay `Temporal.Instant` throughout the
application. The current time is written with `Temporal.Now.instant()`, and the pagination cursor
carries the result of `instant.toString()`, read back with `Temporal.Instant.from(...)`.

## Consequences

`@default(now())` and every time comparison work exactly as the schema declares them, and
`JSON.stringify` emits ISO 8601 through `Instant`'s own `toJSON()` — so the HTTP contract needs no
adjustment at all.

The price is one extra dependency and one import order that must be respected: any module that
touches the database has to go through `src/utils/db.ts`, and moving the polyfill import away from
the top would bring the runtime failure above straight back. A comment in that file states the
reason so nobody tidies it away by accident.

This decision is worth revisiting once Node ships `Temporal` natively; when that happens, the
polyfill can be pulled out without changing any application code.
