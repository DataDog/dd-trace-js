# OTLP Trace Metrics Export — Implementation Plan

## RFC Reference

Based on: `[RFC] OTLP Trace Metrics Export` (Downloads)
Depends on: PR #7531 (OTLP traces support) merged into master

---

## RFC Issues to Resolve Before/During Implementation

**1. Interval coupling (significant architectural issue)**
The RFC proposes `DD_TRACE_OTEL_METRICS_INTERVAL_SECONDS` as a separate config from `stats.interval`.
But both exporters share the same `TimeBuckets` instance, which is drained and cleared on a single
`onInterval()` tick. A different OTLP interval would mean one exporter gets stale/empty bucket data.
**Recommendation:** Remove the separate interval config. Both exporters share the same interval,
resolved via priority: `DD_TRACE_OTEL_METRICS_INTERVAL_SECONDS` → `stats.interval` →
`OTEL_METRIC_EXPORT_INTERVAL` (÷1000) → default 10s.

**2. ExponentialHistogram conversion spec gap (Open Q #1 & #6)**
No mapping from DDSketch indices to OTLP ExponentialHistogram scale/bucket indices is defined.
**Recommendation:** Default `DD_TRACE_OTEL_METRICS_HISTOGRAM_TYPE` to `explicit` for v1.
ExponentialHistogram deferred to a follow-up once the DDSketch→OTLP index mapping is specified.

**3. `_serializeBuckets()` refactor not mentioned in RFC**
The existing method both serializes into Datadog wire format AND clears the buckets. Supporting
dual-exporter requires splitting into `_drainBuckets()` (drain raw) + per-exporter formatting.

**4. `SpanProcessor` activation gate**
`span_processor.js:21` only instantiates `SpanStatsProcessor` when `config.stats?.enabled`.
The RFC says the OTLP path should work even when `DD_TRACE_STATS_COMPUTATION_ENABLED=false`.
Fix: activate when `stats.enabled || otelMetrics.enabled`.

**5. `DD_TRACE_OTEL_METRICS_ENABLED` naming**
OTLP traces uses OTel-standard `OTEL_TRACES_EXPORTER=otlp`. Metrics uses DD-specific
`DD_TRACE_OTEL_METRICS_ENABLED=true` — justified since `OTEL_METRICS_EXPORTER=otlp` is
already used for OTel SDK metrics, but should be clearly documented.

---

## New Files

| File | Purpose |
|---|---|
| `packages/dd-trace/src/exporters/otlp-span-stats/index.js` | `OtlpStatsExporter` |
| `packages/dd-trace/src/exporters/otlp-span-stats/transformer.js` | `OtlpStatsTransformer` |
| `packages/dd-trace/test/exporters/otlp-span-stats/transformer.spec.js` | Transformer unit tests |
| `packages/dd-trace/test/exporters/otlp-span-stats/index.spec.js` | Exporter unit tests |

## Modified Files

| File | Change |
|---|---|
| `packages/dd-trace/src/config/supported-configurations.json` | Add 5 new config entries |
| `packages/dd-trace/src/config/index.js` | OTel fallback chain, gRPC warning, interval conversion |
| `index.d.ts` | `otelMetrics` init option block |
| `docs/API.md` | Document enabled/url/protocol options |
| `packages/dd-trace/src/span_stats.js` | `_drainBuckets()`, dual-exporter `onInterval()`, conditional OTLP exporter init |
| `packages/dd-trace/src/span_processor.js` | Broaden activation condition |
| `packages/dd-trace/test/span_stats.spec.js` | Update for dual-exporter behavior |
| `packages/dd-trace/test/config/index.spec.js` | Config resolution tests |

---

## Step 1 — Configuration

### `supported-configurations.json` — 5 new entries

```
DD_TRACE_OTEL_METRICS_ENABLED  → internalPropertyName: "otelMetrics.enabled"  (boolean, default: false)
DD_TRACE_OTEL_METRICS_URL      → internalPropertyName: "otelMetrics.url"       (string, default: computed)
DD_TRACE_OTEL_METRICS_PROTOCOL → internalPropertyName: "otelMetrics.protocol"  (string, default: "http/protobuf")
DD_TRACE_OTEL_METRICS_INTERVAL_SECONDS → internalPropertyName: "otelMetrics.interval" (number, default: 10)
DD_TRACE_OTEL_METRICS_HISTOGRAM_TYPE   → internalPropertyName: "otelMetrics.histogramType" (string, default: "explicit")
```

### `config/index.js` — OTel env var fallback chain (in `#applyCalculated()`)

**URL resolution:**
1. `DD_TRACE_OTEL_METRICS_URL` (already set via supported-configurations.json)
2. `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (full URL, no path appended)
3. `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/metrics`
4. Default: `http://localhost:4318/v1/metrics`

**Protocol resolution:**
1. `DD_TRACE_OTEL_METRICS_PROTOCOL`
2. `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL`
3. `OTEL_EXPORTER_OTLP_PROTOCOL`
4. Default: `http/protobuf`
- If resolved = `grpc`: warn + fall back to `http/protobuf`

**Interval resolution:**
1. `DD_TRACE_OTEL_METRICS_INTERVAL_SECONDS` (seconds)
2. `OTEL_METRIC_EXPORT_INTERVAL` (milliseconds → ÷1000)
3. Default: 10

### `index.d.ts`

```ts
otelMetrics?: {
  enabled?: boolean
  url?: string
  protocol?: 'http/protobuf' | 'http/json'
  interval?: number
  histogramType?: 'exponential' | 'explicit'
}
```

---

## Step 2 — `SpanStatsProcessor` Refactor (`span_stats.js`)

### Add `_drainBuckets()`

```js
_drainBuckets () {
  const drained = []
  for (const [timeNs, bucket] of this.buckets.entries()) {
    drained.push({ timeNs, bucket })
  }
  this.buckets.clear()
  return drained
}
```

### Update `onInterval()`

```js
onInterval () {
  const drained = this._drainBuckets()
  if (!drained.length) return

  if (this.exporter) {
    // Datadog /v0.6/stats path (unchanged behavior)
    const serialized = drained.map(({ timeNs, bucket }) => ({
      Start: timeNs,
      Duration: this.bucketSizeNs,
      Stats: Array.from(bucket.values(), s => s.toJSON()),
    }))
    this.exporter.export({ Hostname, Env, Version, Stats: serialized, ... })
  }

  if (this.otlpExporter) {
    this.otlpExporter.export(drained, this.bucketSizeNs)
  }
}
```

### Update constructor

- Only create `SpanStatsExporter` when `stats.enabled`
- Create `OtlpStatsExporter` when `otelMetrics.enabled`
- `this.enabled = stats.enabled || otelMetrics.enabled`
- Resource attributes built once: `service.name`, `deployment.environment`, `service.version`, `host.name`, `dd.runtime_id`

### `span_processor.js:21` — broaden activation

```js
// Before:
if (config.stats?.enabled && !config.appsec?.standalone?.enabled)
// After:
if ((config.stats?.enabled || config.otelMetrics?.enabled) && !config.appsec?.standalone?.enabled)
```

---

## Step 3 — `OtlpStatsTransformer` (`exporters/otlp-span-stats/transformer.js`)

Extends `OtlpTransformerBase`. Converts raw `[{timeNs, bucket}]` → `ExportMetricsServiceRequest`.

### Output structure

```
ExportMetricsServiceRequest
└─ ResourceMetrics[]
   ├─ resource.attributes: service.name, deployment.environment, service.version, host.name, dd.runtime_id
   └─ ScopeMetrics[]
      └─ scope: { name: "dd-trace", version: <tracer_version> }
         └─ Metric[]
            ├─ dd.trace.span.hits         (Sum, delta, monotonic, unit: {span})
            ├─ dd.trace.span.errors       (Sum, delta, monotonic, unit: {span})
            ├─ dd.trace.span.top_level_hits (Sum, delta, monotonic, unit: {span})
            └─ dd.trace.span.duration     (Histogram, delta, unit: s)
```

### Dimension mapping (per-datapoint attributes)

| SpanAggKey field | OTLP attribute |
|---|---|
| `name` | `span.name` |
| `resource` | `dd.resource` |
| `type` | `dd.span.type` |
| `statusCode` (if set) | `http.response.status_code` |
| `method` (if set) | `http.request.method` |
| `endpoint` (if set) | `http.route` |
| `synthetics` | `dd.synthetics` |

`service` goes to resource attributes (not per-datapoint).

### Duration histogram (v1)

Use explicit-boundary Histogram. For each `SpanAggStats`, emit two data points:
- One for `okDistribution` (error=false)
- One for `errorDistribution` (error=true)

Use `sketch.count`, `sketch.sum` (ns → seconds ÷1e9), `sketch.min`, `sketch.max`.
`bucketCounts: []`, `explicitBounds: []` — proper bucket subdivision deferred to follow-up.

ExponentialHistogram: emit warning and fall back to explicit when configured (not implemented in v1).

---

## Step 4 — `OtlpStatsExporter` (`exporters/otlp-span-stats/index.js`)

Extends `OtlpHttpExporterBase`.

```js
constructor (otelMetricsConfig, resourceAttributes)
export (drained, bucketSizeNs)  // → transformer.transform() → sendPayload()
```

Telemetry: `otel.span_stats_export_attempts`, `otel.span_stats_export_successes` with `points:<n>` tag.

---

## Step 5 — Tests

### `test/exporters/otlp-span-stats/transformer.spec.js`
- All 4 metrics present with correct name/unit/temporality
- Correct attribute mapping per dimension table
- Hit/error/topLevelHit counts match input
- Duration histogram count/sum/min/max correct
- gRPC protocol → warning + falls back to http/protobuf
- JSON and protobuf output both parseable

### `test/exporters/otlp-span-stats/index.spec.js`
- Empty drained → no HTTP call
- Telemetry incremented on attempt and success

### `test/span_stats.spec.js` (updates)
- `_drainBuckets()` returns correct data and clears buckets
- Both exporters called when both enabled
- Only OTLP exporter called when `stats.enabled=false, otelMetrics.enabled=true`
- Empty buckets → no export calls

### `test/config/index.spec.js` (additions)
- `DD_TRACE_OTEL_METRICS_ENABLED=true` sets `otelMetrics.enabled`
- URL fallback: `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` wins over `OTEL_EXPORTER_OTLP_ENDPOINT`
- URL fallback: `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/metrics`
- URL fallback: default `http://localhost:4318/v1/metrics`
- Protocol: gRPC → warning + `http/protobuf`
- Interval: `OTEL_METRIC_EXPORT_INTERVAL=5000` → `otelMetrics.interval=5`
