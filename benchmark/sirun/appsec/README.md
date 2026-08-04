This benchmarks the cost Datadog AppSec adds to an HTTP server: per-request WAF
handling (a keep-alive client drives the tracer-instrumented server, with
`DD_APPSEC_ENABLED` toggled and an attack-payload variant) and process startup
(loading the tracer with AppSec on versus off). Variants, request counts, and
attack payloads are defined in `meta.json`.

