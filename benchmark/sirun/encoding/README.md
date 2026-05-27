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

Variants:

- `0.4` / `0.5` — wire-format variants of the agent encoder.
- `0.4-events-native` / `0.4-events-legacy` / `0.5-events-legacy` —
  exercise the span-event encoding paths (`WITH_SPAN_EVENTS`).
