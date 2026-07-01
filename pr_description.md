### What does this PR do?

Adds OTLP span metrics export and extends the existing trace stats aggregation key with new dimensions (`span.kind`, `rpc.response.status_code`, `origin`) to bring dd-trace-js to parity with other Datadog SDKs.

### Motivation

When `OTEL_TRACES_EXPORTER=otlp` is active, the Datadog Agent no longer receives `/v0.6/stats` — span metrics that APM depends on are lost. This PR adds a native JS implementation that aggregates span stats and emits them as a `traces.span.sdk.metrics.duration` delta histogram to `/v1/metrics`. It is a bridge until the libdatadog-based concentrator lands in dd-trace-js; the aggregation key and wire format are kept in sync with libdatadog to make that a drop-in swap.

### Additional Notes

**Activation**: `OTEL_TRACES_SPAN_METRICS_ENABLED=true`, or auto-enabled when both `OTEL_TRACES_EXPORTER=otlp` and `DD_METRICS_OTEL_ENABLED=true` are set.

**Mutual exclusion**: the OTLP and native `/v0.6/stats` export paths are mutually exclusive. When the OTLP exporter is injected, the native `SpanStatsExporter` is never constructed and `onInterval` uses `else if` to enforce this structurally.

**New aggregation dimensions** (both modes): `span.kind`, `origin`, and `rpc.response.status_code` (from `grpc.status.code`, emitted as string per libdatadog semantics) are now always included in `SpanAggKey`. The native `/v0.6/stats` wire payload is unchanged; only the JS-side bucketing is more granular.

**Agent coordination**: `_dd.stats_computed: "true"` is added as a resource attribute on OTLP trace exports when active, preventing the Agent's OTLP receiver from double-counting. `Datadog-Client-Computed-Stats: yes` is still sent on the native path.

**Histogram**: `count`/`sum`/`min`/`max` are DDSketch exact scalars. Bucket distribution is projected onto fixed explicit bounds matching libdatadog's `EXPLICIT_BOUNDS_SECONDS`.

**Code structure**: all OTLP-specific code lives under `packages/dd-trace/src/opentelemetry/metrics/`. `SpanStatsProcessor` receives the exporter via DI from `opentracing/tracer.js`; `span_stats.js` has no imports from `opentelemetry/`.

**OTel semantics mode**: when `DD_TRACE_OTEL_SEMANTICS_ENABLED=true`, `dd.*` attributes are omitted from trace metrics data points.

**Known gaps** (tracked separately): cross-service entry spans not tagged top-level (FR06.3); p0 traces not dropped when client stats are active (FR09.1).

**Tests**: `test/span_stats.spec.js`, `test/opentelemetry/metrics/otlp_span_stats_exporter.spec.js`, `test/opentelemetry/metrics/otlp_span_stats_transformer.spec.js`. Cross-tracer coverage via the system-tests parametric suite.
