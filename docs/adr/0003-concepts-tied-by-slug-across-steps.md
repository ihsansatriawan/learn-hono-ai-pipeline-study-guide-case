# 3. Concepts are tied together by slug across steps

Date: 2026-09-12

## Status

Accepted

## Context

The second step explains every Concept in a single model call, and the third step writes questions
for every Concept in one more call. Three calls per Study Job, however many Concepts there are —
cost and processing time stay predictable.

The price of batching is alignment. The model may return explanations in a different order, merge
two Concepts, or drop one in the middle of a long list. Relying on array position means relying on
a promise no model provider guarantees, and explanations swapped between Concepts are an invisible
mistake: the result is still schema-valid, still readable, and still wrong.

## Decision

The first step gives every Concept a stable, unique `slug`. The output schemas of the second and
third steps require every item to carry that `slug` back.

The fourth step does not call the model at all. It matches on the slug, not on position:

- an unknown slug — discarded; the model produced something nobody asked for.
- a slug that should be there but is missing — a transient failure; the Study Job is retried.
- fewer than two Concepts in the first step — Unprocessable Source; a permanent failure.

## Consequences

Explanations and questions cannot be swapped between Concepts without detection; an alignment
failure turns from a silent mistake into a loud one.

The fourth step becomes the single place where the completeness rules are enforced, and it can be
tested without touching the network because it never calls the model.

The price is that the output schemas of the second and third steps are busier, and the prompts have
to insist on returning the slug. Some of the model's capacity goes on copying identifiers instead
of writing content.
