This bench sends a single pre-formatted trace through the encoder many times
with a null writer, so all I/O is excluded and the cost being measured is the
encoder itself.

The trace shape (`trace-fixture.js`) mirrors a typical Node.js HTTP-service
request: one root Express server span plus a fan of internal middleware spans,
Postgres / Redis client spans, a few outbound HTTP client spans, DNS lookups,
and one error-bearing span with `error.message` / `error.stack`. The default
trace has 30 spans; `TRACE_SPANS=<n>` scales the composition proportionally.

Strings reuse the same keys (`span.kind`, `component`, `runtime-id`, …) and
the same hot values (`GET`, `server`, `client`, `internal`, `javascript`, …)
across spans, mirroring what the encoder's string cache sees in production.

`tickTrace(trace, iteration)` runs before every encode and rewrites the
per-request dynamic fields in place: `start` nanos and `duration`
advance, the low half of every ID buffer is rewritten, `db.row_count`
on the Postgres spans jitters, the root span rotates through eight
coherent request shapes (route / URL / resource / status / client IP),
and the error span rotates through four type/message/stack variants
(each stack ~1.5 KB). Without that, every iteration encodes
byte-identical data and V8 collapses the integer magnitude branches
plus the stale-string cache hits the encoder is meant to exercise.
`attachFreshEvents` does the same for `span_events` (legacy path).

The `+ iteration * 4096` step on `span.start` is well above the
IEEE-754 double's ULP at the ~1.7e18 nano-timestamp magnitude (256
nanos); fixing that precision loss properly needs the span to carry
`start` as a `BigInt` instead of a `Number`, which is a separate
change on the tracer side, not here.

Variants:

- `0.4` / `0.5` — wire-format variants of the agent encoder.
- `0.4-events-native` / `0.4-events-legacy` / `0.5-events-legacy` —
  exercise the span-event encoding paths (`WITH_SPAN_EVENTS`).
