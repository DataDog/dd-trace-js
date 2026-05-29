Measures the agent trace encoder in isolation: a pre-built trace is encoded many
times through a null writer so only the encoder cost is measured. The fixture
(`trace-fixture.js`) mirrors a typical Node.js HTTP-service request (~30 spans:
an Express root, middleware, Postgres/Redis/HTTP-client/DNS spans, one error
span) with reused keys and hot values to match the encoder's string cache.
`tickTrace` rewrites the per-request dynamic fields before each encode so V8 does
not collapse the magnitude branches and stale-cache hits the encoder must
exercise. `TRACE_SPANS=<n>` scales the trace; variants `0.4`/`0.5` cover the wire
formats and the `*-events-*` variants the span-event paths.
