# RFC: OTLP-Based Client-Side Stats Computation for Datadog SDKs

- **Author(s):** \[TBD\]
- **Date:** 2026-04-07
- **Status:** Draft
- **Approvers:** \[TBD\]

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Glossary](#glossary)
3. [Goals](#goals)
4. [Non-Goals](#non-goals)
5. [Background](#background)
6. [Proposal](#proposal)
7. [Requirements](#requirements)
8. [Design](#design)
9. [Configuration](#configuration)
10. [Migration Path](#migration-path)
11. [Alternative Solutions](#alternative-solutions)
12. [Implementation Plan](#implementation-plan)
13. [Open Questions](#open-questions)
14. [References](#references)

---

## Executive Summary

Datadog APM SDKs today compute per-span aggregate metrics client-side
(hits, errors, duration distributions) and submit them as MessagePack payloads
to the Datadog Agent at `PUT /v0.6/stats`. This RFC proposes a parallel
export path that emits the same logical metrics in **OTLP format** using
**OpenTelemetry semantic conventions**, targeting OTLP-compatible receivers
(HTTP and, where supported, gRPC). The new path is additive — the existing
`/v0.6/stats` path is unchanged — and is controlled by a new configuration
flag distinct from `DD_TRACE_STATS_COMPUTATION_ENABLED`.

---

## Glossary

- **Client-side stats computation / Client-side trace stats aggregation:** The process by which Datadog APM SDKs locally aggregate finished span data into statistical summaries (hit counts, error counts, duration distributions) and submit those summaries independently of the raw trace payload. Controlled today by `DD_TRACE_STATS_COMPUTATION_ENABLED`.

- **DDSketch:** A mergeable, quantile-accurate probabilistic data structure used to represent duration distributions. Datadog SDKs encode DDSketch summaries as protobuf bytes (`OkSummary` / `ErrorSummary`) inside the `/v0.6/stats` payload.

- **DogStatsD:** An open-source implementation of the StatsD metrics protocol with Datadog-specific extensions. Today, the Datadog SDKs have built-in DogStatsD clients (which may be optionally exposed to users via the public API) to deliver APM features such as Runtime Metrics and client-side trace stats aggregation.

- **ExponentialHistogram:** An OTLP histogram encoding that uses base-2 exponential bucket boundaries, providing high-resolution distribution summaries without requiring pre-defined explicit boundaries. The preferred encoding for mapping DDSketch distributions to OTLP.

- **OpenTelemetry Protocol (OTLP):** A general-purpose telemetry protocol that encompasses all of the signals that OpenTelemetry SDKs may produce, including traces, metrics, and logs. This is the vendor-neutral standard for observability and has widespread adoption over other competing protocols.

- **OTel API / OpenTelemetry API:** The OTel Metrics API, which provides an abstraction for creating individual metric types and recording values on those metrics.

- **OTel SDK / OpenTelemetry SDK:** The language-dependent implementation of the OTel API provided by the OpenTelemetry project.

- **OTel semantic conventions (semconv):** Standardized attribute names and metric names defined by the OpenTelemetry project (e.g. `http.request.method`, `http.response.status_code`, `service.name`). This RFC uses semconv attributes as dimension names when mapping span metadata to OTLP metric datapoints.

- **OTLP metrics receiver:** Any component that accepts `ExportMetricsServiceRequest` payloads over HTTP (`/v1/metrics`) or gRPC. Examples include the Datadog Agent OTLP ingest endpoint and the OpenTelemetry Collector.

- **ResourceMetrics:** The top-level grouping unit in the OTLP metrics data model. A `ResourceMetrics` message bundles a set of metrics with a shared `Resource` (e.g. `service.name`, `host.name`) describing the entity that produced them.

- **Delta temporality:** An OTLP aggregation temporality in which each export contains only the measurements accumulated since the previous export. This matches the flush-and-reset semantics of the existing `/v0.6/stats` path and is the temporality used by all metrics defined in this RFC.

---

## Goals

- Emit client-computed span metrics via OTLP to any OTel-compatible metrics
  backend, including the Datadog Agent OTLP receiver and third-party collectors.
- Use OpenTelemetry semantic conventions where applicable (e.g., `http.*`
  attributes from OTel HTTP Metrics semconv).
- Maintain feature parity with the existing `/v0.6/stats` data model:
  the same spans are measured, the same dimensions are captured.
- Ship across all major Datadog APM SDKs: dd-trace-js, dd-trace-py,
  dd-trace-java, dd-trace-dotnet, dd-trace-rb, dd-trace-php, and
  dd-trace-go.
- Support HTTP OTLP export in all SDKs; additionally support gRPC in Python
  (and others as transport availability allows).

---

## Non-Goals

- Replacing the existing `/v0.6/stats` endpoint — both paths may co-exist.
- Defining new span instrumentation or changing which spans are measured.
- Changing the DDSketch accuracy parameters or bucketing interval defaults.
- Implementing OTLP trace export (traces already have a separate OTLP path).
- Per-SDK custom metric collection beyond the span-derived stats described here.
- Full OTel Metrics SDK integration within each tracer (this RFC uses a
  lightweight OTLP metrics serializer, not the OTel Metrics SDK).

---

## Background

### Existing Client-Side Stats Computation

When `DD_TRACE_STATS_COMPUTATION_ENABLED=true`, each SDK:

1. **Filters** finished spans to those tagged `_dd.top_level=1` or `_dd.measured=1`.
2. **Aggregates** filtered spans into 10-second time buckets keyed by:
   `(name, service, resource, type, http_status_code, synthetics, http_method, http_endpoint)`.
3. **Accumulates** per-key counters and DDSketch distributions:
   - `Hits` — total span count
   - `TopLevelHits` — count of top-level spans
   - `Errors` — count of error spans
   - `Duration` — sum of durations (nanoseconds)
   - `OkSummary` — DDSketch of successful-span durations
   - `ErrorSummary` — DDSketch of error-span durations
4. **Exports** each bucket as a MessagePack payload to `PUT /v0.6/stats`.
5. Sets the `Datadog-Client-Computed-Stats: yes` header on trace exports so the
   Agent can skip redundant server-side stats computation.

This path is tightly coupled to the Datadog Agent wire format and is opaque
to non-Datadog backends.

### OTLP Metrics Overview

OTLP (OpenTelemetry Protocol) defines a vendor-neutral wire format for
metrics over HTTP/JSON, HTTP/protobuf, or gRPC/protobuf. The OTel Metrics
data model supports:

- **Sum** — monotonic or non-monotonic cumulative or delta counters
- **Gauge** — point-in-time values
- **Histogram** — explicit-boundary or exponential bucket histograms
- **ExponentialHistogram** — base-2 exponential bucket histograms

OTel semantic conventions for HTTP define `http.server.request.duration`
(histogram, seconds) and `http.client.request.duration` (histogram, seconds)
as the canonical latency metrics.

### Current OTLP Metrics Path (Span Metrics Connector)

When Datadog SDKs export spans as OTLP, they cannot rely on the Trace Agent for
client-side stats computation. The existing workaround requires users to send 100%
of spans to an OTel Collector configured with the Span Metrics Connector (SMC)
component, which generates an OTLP metrics payload from the collected spans. This
approach has two significant drawbacks:

- It requires 100% of spans to be forwarded to the OTel Collector, which is
  prohibitively expensive at scale and incompatible with head-based sampling.
- It depends on a Datadog-specific or SMC-specific collector component, which is
  not part of the default OTel Collector distribution and requires manual
  configuration by the user.

---

## Proposal

There are two complementary approaches to generating trace metrics in an OTel-native
way when Datadog SDKs export OTLP spans.

### 1 — Sampling Decision in TraceState (Phase 2)

The SDK implements W3C Trace Context Level 2 with TraceState Probability Sampling:

- A rejection threshold (`th`) and randomness value (`rv`) are written into the
  `ot` vendor entry of the `tracestate` header on each sampled span.
- If no explicit randomness value is provided, the least-significant 56 bits of the
  TraceID are used as the randomness source, ensuring consistent probability sampling.
- The OTel Collector Span Metrics Connector reads these fields and uses the recorded
  sampling probability to extrapolate accurate hit/error/duration metrics from the
  sampled spans — eliminating the requirement to send 100% of spans.
- This approach is opt-in via a configuration flag for W3C tracestate propagation.
- Targeted for Phase 2 (2026Q2+) across all core SDKs.

### 2 — Client-Side Stats Computation in Datadog SDKs (This RFC)

The SDK computes client-side stats and exports them as OTLP metrics directly,
without requiring an OTel Collector:

- Uses the same aggregation logic as the existing `/v0.6/stats` path: finished
  spans are filtered (top-level or `_dd.measured=1`), then aggregated into 10-second
  time buckets keyed by `(name, service, resource, type, http_status_code,
  synthetics, http_method, http_endpoint)`.
- Per-bucket, the SDK accumulates hit count, error count, top-level hit count, and
  DDSketch duration distributions (split by ok/error).
- At flush time, a new `OtlpStatsExporter` serializes the bucket contents into an
  `ExportMetricsServiceRequest` and `POST`s it to `/v1/metrics` on the configured
  OTLP endpoint.
- Metrics emitted (all delta temporality): `dd.trace.span.hits`,
  `dd.trace.span.errors`, `dd.trace.span.top_level_hits`, `dd.trace.span.duration`.
- OTel semantic convention attributes are used for dimension mapping where applicable
  (e.g. `http.request.method`, `http.response.status_code`, `http.route`).
- A custom lightweight OTLP protobuf/JSON serializer is used — not the full OTel
  Metrics SDK — to avoid dependency conflicts and minimize overhead.
- Both the `/v0.6/stats` path and the new OTLP path can run simultaneously; each is
  independently controlled.
- New opt-in flag: `DD_TRACE_OTEL_METRICS_ENABLED` (default: `false`).

---

## Requirements

### Functional

| ID | Requirement |
|----|-------------|
| F-1 | Span filtering logic (top-level / measured) is identical to the existing path. |
| F-2 | Aggregation key dimensions are mapped to OTel attributes (see [Dimension Mapping](#dimension-mapping)). |
| F-3 | Duration distributions are exported as OTLP Histograms or ExponentialHistograms. |
| F-4 | Hit, error, and top-level-hit counters are exported as OTLP Sum metrics with delta temporality. |
| F-5 | Export interval default is 10 seconds, matching the existing path. |
| F-6 | Export targets an OTLP metrics endpoint (HTTP required; gRPC optional per SDK). |
| F-7 | Feature is disabled by default; enabled by a new opt-in config flag. |
| F-8 | The existing `/v0.6/stats` export is unaffected; both paths may run simultaneously. |

### Non-Functional

| ID | Requirement |
|----|-------------|
| NF-1 | No measurable hot-path overhead beyond the existing stats aggregation. |
| NF-2 | Serialization happens off the span processing hot path (flush thread/timer). |
| NF-3 | Implementation uses a minimal OTLP protobuf/JSON serializer — not the full OTel SDK. |
| NF-4 | Target Node.js 18+ for dd-trace-js (consistent with existing support matrix). |

---

## Design

### High-Level Architecture

```
  Span lifecycle
       │
       ▼
  SpanStatsProcessor  (unchanged)
       │ onSpanFinished()
       ▼
  TimeBuckets / SpanBuckets  (unchanged aggregation)
       │
       ├──► SpanStatsExporter ──► PUT /v0.6/stats  (existing)
       │
       └──► OtlpStatsExporter ──► POST /v1/metrics  (new)
                                  (OTLP HTTP protobuf or JSON)
```

Both exporters share the same in-memory aggregation structures. The OTLP
exporter is an additional flush consumer, not a replacement.

### Dimension Mapping

The existing Datadog aggregation key fields map to OTel attributes as follows:

| Datadog Field | OTel Attribute | Notes |
|---|---|---|
| `service` | `service.name` | Resource attribute |
| `name` | `span.name` | Metric attribute (Datadog-specific) |
| `resource` | `dd.resource` | Metric attribute (Datadog-specific) |
| `type` | `dd.span.type` | Metric attribute (Datadog-specific) |
| `http_status_code` | `http.response.status_code` | OTel semconv |
| `http_method` | `http.request.method` | OTel semconv |
| `http_endpoint` | `http.route` | OTel semconv |
| `synthetics` | `dd.synthetics` | Metric attribute (Datadog-specific) |
| `env` | `deployment.environment` | Resource attribute |
| `version` | `service.version` | Resource attribute |
| `runtime_id` | `process.runtime.name` + `dd.runtime_id` | Resource attribute |
| `hostname` | `host.name` | Resource attribute |

`service.name`, `deployment.environment`, `service.version`, and `host.name`
are represented as **OTLP Resource attributes** (shared across all metrics in
a `ResourceMetrics` batch). All other fields are per-datapoint attributes.

### OTLP Metric Definitions

All metrics use **delta temporality** to match the flush-and-reset semantics
of the existing stats export.

#### `dd.trace.span.duration` — Histogram

Measures span duration; replaces `OkSummary` / `ErrorSummary` distributions.

| Property | Value |
|---|---|
| Unit | `s` (seconds) |
| Temporality | Delta |
| Attributes | All dimension-mapped attributes + `error` (`true`/`false`) |

Implementation note: DDSketch distributions should be serialized as
**ExponentialHistogram** (OTLP base-2) to preserve distribution fidelity.
A fallback to explicit-boundary Histogram is acceptable where ExponentialHistogram
is not supported by the receiving backend. Bucket boundaries TBD in a follow-up
detailed spec.

#### `dd.trace.span.hits` — Sum (monotonic, delta)

Total span count per aggregation key.

| Property | Value |
|---|---|
| Unit | `{span}` |
| Temporality | Delta |
| Attributes | All dimension-mapped attributes |

#### `dd.trace.span.errors` — Sum (monotonic, delta)

Error span count per aggregation key.

| Property | Value |
|---|---|
| Unit | `{span}` |
| Temporality | Delta |
| Attributes | All dimension-mapped attributes |

#### `dd.trace.span.top_level_hits` — Sum (monotonic, delta)

Count of top-level spans per aggregation key.

| Property | Value |
|---|---|
| Unit | `{span}` |
| Temporality | Delta |
| Attributes | All dimension-mapped attributes |

### OTLP Payload Structure

Each flush emits one `ExportMetricsServiceRequest` containing a single
`ResourceMetrics`:

```
ExportMetricsServiceRequest
└─ ResourceMetrics[]
   ├─ resource
   │   └─ attributes: service.name, deployment.environment, service.version,
   │                  host.name, dd.runtime_id
   └─ ScopeMetrics[]
       └─ scope: name="dd-trace", version=<tracer_version>
           └─ Metric[]
               ├─ dd.trace.span.hits        (Sum)
               ├─ dd.trace.span.errors      (Sum)
               ├─ dd.trace.span.top_level_hits (Sum)
               └─ dd.trace.span.duration    (ExponentialHistogram or Histogram)
```

Each `DataPoint` corresponds to one entry in a time bucket and carries:
- `start_time_unix_nano` — bucket start timestamp
- `time_unix_nano` — bucket end timestamp (start + interval)
- `attributes` — per-span-group dimension attributes
- value fields per metric type

### Transport

| SDK | HTTP | gRPC |
|-----|------|------|
| dd-trace-js | Required | Not supported |
| dd-trace-py | Required | Required |
| dd-trace-java | Required | Required |
| dd-trace-dotnet | Required | Optional |
| dd-trace-rb | Required | Optional |
| dd-trace-php | Required | Not supported |
| dd-trace-go | Required | Required |

**HTTP endpoint:** `POST <base_url>/v1/metrics`
**Content-Type:** `application/x-protobuf` (primary), `application/json` (fallback)
**Default base URL:** `http://localhost:4318` (standard OTLP HTTP receiver port)

The URL is independently configurable from the trace export URL.

---

## Configuration

### New Configuration Options

| Option | Env Var | Type | Default | Description |
|--------|---------|------|---------|-------------|
| `otelMetrics.enabled` | `DD_TRACE_OTEL_METRICS_ENABLED` | bool | `false` | Enable OTLP metrics export |
| `otelMetrics.url` | `DD_TRACE_OTEL_METRICS_URL` | string | `http://localhost:4318` | OTLP metrics endpoint base URL |
| `otelMetrics.protocol` | `DD_TRACE_OTEL_METRICS_PROTOCOL` | `http/protobuf` \| `http/json` \| `grpc` | `http/protobuf` | OTLP transport protocol |
| `otelMetrics.interval` | `DD_TRACE_OTEL_METRICS_INTERVAL_SECONDS` | int | `10` | Flush interval in seconds |
| `otelMetrics.histogramType` | `DD_TRACE_OTEL_METRICS_HISTOGRAM_TYPE` | `exponential` \| `explicit` | `exponential` | Histogram encoding to use |

### Interaction With Existing Config

- `DD_TRACE_STATS_COMPUTATION_ENABLED` continues to control the `/v0.6/stats` path.
- `DD_TRACE_OTEL_METRICS_ENABLED` controls only the OTLP path.
- Both may be enabled simultaneously (metrics are computed once and flushed to
  both exporters).
- When `DD_TRACE_OTEL_METRICS_ENABLED=true` and
  `DD_TRACE_STATS_COMPUTATION_ENABLED=false`, the OTLP path still requires span
  filtering and aggregation; the internal aggregator is shared.

### Standard OTel Environment Variables and Resolution Priority

Each configurable option resolves its final value by walking the following
priority chain, stopping at the first source that provides a value.
Higher entries override lower ones.

#### `otelMetrics.url` — export endpoint base URL

| Priority | Source | Value used |
|----------|--------|------------|
| 1 (highest) | Programmatic API (`DD_TRACE_OTEL_METRICS_URL` equivalent in code) | Exact URL provided |
| 2 | `DD_TRACE_OTEL_METRICS_URL` | Exact URL provided |
| 3 | `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Exact URL provided (already includes path; skip appending `/v1/metrics`) |
| 4 | `OTEL_EXPORTER_OTLP_ENDPOINT` | Append `/v1/metrics` to form the full endpoint |
| 5 (lowest) | Default | `http://localhost:4318` (append `/v1/metrics` → `http://localhost:4318/v1/metrics`) |

> **Note:** When `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` is used, it is treated
> as a full endpoint URL (no path appended). When `OTEL_EXPORTER_OTLP_ENDPOINT`
> is used, `/v1/metrics` is appended per the OTLP spec.

#### `otelMetrics.protocol` — transport protocol

| Priority | Source | Accepted values |
|----------|--------|-----------------|
| 1 (highest) | Programmatic API |`http/protobuf`, `http/json`, `grpc` |
| 2 | `DD_TRACE_OTEL_METRICS_PROTOCOL` | `http/protobuf`, `http/json`, `grpc` |
| 3 | `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` | `http/protobuf`, `http/json`, `grpc` |
| 4 | `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf`, `http/json`, `grpc` |
| 5 (lowest) | Default | `http/protobuf` |

> **Note:** If the resolved protocol is `grpc` on an SDK that does not support
> gRPC (e.g. dd-trace-js, dd-trace-php), the SDK must emit a warning and fall
> back to `http/protobuf`.

#### `otelMetrics.interval` — flush interval

| Priority | Source | Notes |
|----------|--------|-------|
| 1 (highest) | Programmatic API | Value in seconds |
| 2 | `DD_TRACE_OTEL_METRICS_INTERVAL_SECONDS` | Value in seconds |
| 3 | `OTEL_METRIC_EXPORT_INTERVAL` | Value in milliseconds per OTel spec; convert to seconds internally |
| 4 (lowest) | Default | `10` seconds |

> **Note:** `OTEL_METRIC_EXPORT_INTERVAL` uses milliseconds. SDKs must divide
> by 1000 when reading it.

#### `otelMetrics.enabled` — feature flag

| Priority | Source | Notes |
|----------|--------|-------|
| 1 (highest) | Programmatic API | `true` / `false` |
| 2 | `DD_TRACE_OTEL_METRICS_ENABLED` | `true` / `false` |
| 3 (lowest) | Default | `false` |

There is no OTel standard env var for enabling/disabling metrics export;
this option has no OTel fallback.

#### `otelMetrics.histogramType` — histogram encoding

| Priority | Source | Accepted values |
|----------|--------|-----------------|
| 1 (highest) | Programmatic API | `exponential`, `explicit` |
| 2 | `DD_TRACE_OTEL_METRICS_HISTOGRAM_TYPE` | `exponential`, `explicit` |
| 3 (lowest) | Default | `exponential` |

There is no OTel standard env var for histogram type; this option has no OTel
fallback.

#### Summary table

| Option | Programmatic API | DD env var | OTel env var (signal-specific) | OTel env var (generic) | Default |
|--------|-----------------|------------|-------------------------------|------------------------|---------|
| URL | ✓ | `DD_TRACE_OTEL_METRICS_URL` | `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` |
| Protocol | ✓ | `DD_TRACE_OTEL_METRICS_PROTOCOL` | `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` | `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` |
| Interval | ✓ | `DD_TRACE_OTEL_METRICS_INTERVAL_SECONDS` | `OTEL_METRIC_EXPORT_INTERVAL` (ms) | — | `10`s |
| Enabled | ✓ | `DD_TRACE_OTEL_METRICS_ENABLED` | — | — | `false` |
| Histogram type | ✓ | `DD_TRACE_OTEL_METRICS_HISTOGRAM_TYPE` | — | — | `exponential` |

---

## Migration Path

1. **Phase 1 (this RFC):** Introduce `DD_TRACE_OTEL_METRICS_ENABLED` opt-in
   across all SDKs. Both paths run simultaneously. Validate metric equivalence
   between `/v0.6/stats` and OTLP output.
2. **Phase 2 (future RFC):** Define a deprecation schedule for the
   `/v0.6/stats` path once OTLP path reaches feature parity and
   sufficient adoption.
3. **Phase 3 (future RFC):** Remove the `/v0.6/stats` path after a
   major version bump, if/when appropriate.

---

## Alternative Solutions

### A. Use the OTel Metrics SDK Directly

Each SDK embeds the official OTel Metrics SDK and registers instruments.
The SDK handles batching, temporality, and OTLP export.

**Pros:** Full OTel compliance; reuses well-tested export infrastructure.
**Cons:** Significant binary size / dependency footprint; OTel Metrics SDK
initialization conflicts with user-managed OTel setups; introduces `async/await`
patterns in some SDKs; adds maintenance surface.

**Decision:** Rejected for initial implementation. The lightweight custom
serializer in option B is preferred. Re-evaluate in Phase 2.

### B. Custom Lightweight OTLP Serializer (Selected)

Each SDK implements a minimal serializer that maps the existing
`SpanAggStats` / `TimeBuckets` structures directly to OTLP protobuf/JSON.
No OTel SDK dependency.

**Pros:** Minimal overhead; no dependency conflicts; matches the existing
dd-trace pattern for custom encoding (e.g., `encode/span-stats.js`).
**Cons:** Each SDK must maintain its own serializer; risk of drift from
OTel spec.

### C. Agent-Side Translation

The Datadog Agent receives `/v0.6/stats` as today and translates to OTLP
internally before forwarding.

**Pros:** Zero SDK changes.
**Cons:** Requires Agent changes; doesn't support sending to non-Datadog OTLP
receivers; defeats the purpose of OTel portability.

### D. Emit Only HTTP-Semantic Metrics (OTel Semconv)

Instead of generic `dd.trace.span.*` metrics, emit only the OTel standard
`http.server.request.duration` and `http.client.request.duration` histograms
for HTTP spans, and omit non-HTTP spans entirely.

**Pros:** Fully standard metric names; no Datadog-specific attributes needed.
**Cons:** Loses non-HTTP span coverage (DB, cache, messaging, etc.);
loses `hits` / `top_level_hits` / `errors` counters; reduced feature parity.

**Decision:** Rejected as the primary approach. OTel semconv attributes
(`http.response.status_code`, `http.request.method`, `http.route`) are used
for dimension mapping (see [Dimension Mapping](#dimension-mapping)), but metric
names remain `dd.trace.span.*` to cover all span types uniformly.

---

## Implementation Plan

### Java

- Look into what Stuart McCulloch already implemented for Solution 2; reuse/extend
  his implementation where possible.
- Wire up an `OtlpStatsExporter` as an additional flush consumer alongside the
  existing `/v0.6/stats` exporter; both share the same in-memory bucket structures.
- HTTP required; gRPC required (Java defaults to gRPC for backward compatibility).
- Add `DD_TRACE_OTEL_METRICS_ENABLED` config flag and honor the OTel env var
  fallback chain.
- Confirm preferred protobuf library and gRPC availability with Stuart.

### .NET

- Solution 2 POC is already complete (Zach Montoya); promote to production
  implementation.
- Note: implementing the OTel Metrics API itself is out of scope for .NET — the
  OTel Metrics API lives in the .NET BCL runtime, not the OTel API package — but
  the OTLP metrics *export* path still applies.
- HTTP required; gRPC optional.
- Wire up proper configuration (`DD_TRACE_OTEL_METRICS_ENABLED`,
  `DD_TRACE_OTEL_METRICS_URL`, etc.) and validate metric equivalence against
  existing `/v0.6/stats` output.

### Python

- Implement Solution 2 via libdatadog (native tracer writer), consistent with the
  OTLP traces exporter approach for Python.
- Implement lightweight OTLP metrics serializer in libdatadog, feeding from the
  existing `ddtrace/internal/processor/stats.py` aggregation.
- HTTP required; gRPC required.
- Add `DD_TRACE_OTEL_METRICS_ENABLED` config flag; support both `http/protobuf` and
  `grpc` protocols.

### NodeJS

- Implement Solution 2 in JavaScript (not via libdatadog, consistent with the rest
  of dd-trace-js).
- HTTP only — gRPC is not supported; if the `grpc` protocol is configured, emit a
  warning and fall back to `http/protobuf`.
- Build `OtlpStatsExporter` as an additional flush consumer alongside the existing
  `SpanStatsExporter` (see `packages/dd-trace/src/exporters/span-stats/writer.js`);
  both exporters share the same `TimeBuckets`/`SpanBuckets` structures from
  `packages/dd-trace/src/span_stats.js`.
- Serialize bucket contents directly to OTLP JSON or protobuf — no OTel Metrics SDK
  dependency.
- Implement the full config surface: `DD_TRACE_OTEL_METRICS_ENABLED`,
  `DD_TRACE_OTEL_METRICS_URL`, `DD_TRACE_OTEL_METRICS_PROTOCOL`,
  `DD_TRACE_OTEL_METRICS_INTERVAL_SECONDS`, `DD_TRACE_OTEL_METRICS_HISTOGRAM_TYPE`;
  honor OTel env var fallback chain.
- Default histogram encoding: `ExponentialHistogram`; fall back to explicit-boundary
  Histogram when the receiving backend does not support it.
- Target Node.js 18+ (consistent with existing support matrix).

### Go

- Implement Solution 2 with a custom lightweight OTLP metrics serializer.
- Wire up `OtlpStatsExporter` as an additional flush consumer alongside the existing
  stats exporter; both share the same in-memory aggregation structures.
- HTTP required; gRPC required.
- Add `DD_TRACE_OTEL_METRICS_ENABLED` config flag and honor the OTel env var
  fallback chain.
- Confirm preferred protobuf library with Go SDK owners.

### Non-Core SDKs

PHP, Ruby, Cpp, and Rust implementations are deferred to Q3. Implementation details
will be filled out at a future date.

---

## Open Questions

1. **DDSketch → ExponentialHistogram conversion:** What is the preferred mapping
   from DDSketch bucket indices to OTLP ExponentialHistogram scale/bucket
   indices? A detailed spec is needed before implementation.
2. **ProcessTags:** The existing `/v0.6/stats` payload includes `ProcessTags`
   (e.g., `entrypoint.name:app`). Should these map to OTel resource attributes
   or be dropped?
3. **Synthetics dimension:** `dd.synthetics` is a Datadog-specific boolean.
   Is there a standard OTel attribute or should a `dd.*` namespace attribute
   be used?
4. **Agent OTLP receiver port:** The default `localhost:4318` assumes the
   Datadog Agent OTLP receiver is enabled. Should the default fall back to the
   Agent URL when no explicit OTLP URL is configured?
5. **gRPC support per SDK:** Confirm gRPC availability and preferred protobuf
   library per SDK with SDK owners.
6. **Histogram type default:** Some backends do not yet support
   ExponentialHistogram. Should `explicit` be the safer default?

---

## References

- [OTel HTTP Metrics Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/)
- [OTLP Specification](https://opentelemetry.io/docs/specs/otlp/)
- [OTel Metrics Data Model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/)
- dd-trace-js stats implementation: `packages/dd-trace/src/span_stats.js`
- dd-trace-js stats encoder: `packages/dd-trace/src/encode/span-stats.js`
- dd-trace-js stats writer: `packages/dd-trace/src/exporters/span-stats/writer.js`
- dd-trace-py stats implementation: `ddtrace/internal/processor/stats.py`
- \[Internal\] OTLP Traces Support design doc: *(link TBD)*
- \[Internal\] Client-side stats background doc: *(link TBD)*
- \[Internal\] SDK OTLP metrics requirements doc: *(link TBD)*
