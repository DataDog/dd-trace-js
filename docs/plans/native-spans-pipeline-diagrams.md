# Native Spans Pipeline: Standard vs Native Mode

```
STANDARD MODE (native spans disabled)
══════════════════════════════════════

  app code
    │
    ▼
  tracer._startSpan()
    │
    ▼
  new DatadogSpan           ←── JS object, tags in ._tags
    │
    │  span.setTag(k,v)     ←── direct property write
    │  span.finish()
    │
    ▼
  SpanProcessor.process()
    │
    ├── sample()             ←── JS PrioritySampler (rules, rates, limiter)
    ├── gitMetadataTagger()  ←── sets _dd.git.* on trace tags
    │
    ├── for each finished span:
    │     spanFormat(span)   ←── JS: reads ._tags, builds {name,service,
    │       │                    resource,type,meta,metrics,start,duration}
    │       │
    │       ├──► formatted ──► AgentExporter.export()
    │       │                     │
    │       │                     ▼
    │       │                  JS msgpack encode
    │       │                     │
    │       │                     ▼
    │       │                  HTTP POST /v0.4/traces  (Node.js http)
    │       │
    │       └──► SpanStatsProcessor.onSpanFinished(formatted)
    │               │
    │               ├── check _dd.top_level || _dd.measured
    │               ├── bucketTime = align(endTime, 10s)
    │               ├── aggKey = {name,svc,resource,type,status,method,endpoint}
    │               ├── hits++, errors++, duration +=
    │               ├── okDistribution.accept(duration)   ←── JS DDSketch
    │               └── errorDistribution.accept(duration) ←── JS DDSketch
    │
    └── _erase(trace)        ←── clears ._tags on finished spans
              │
              ▼  (every 10s, JS setInterval)
         SpanStatsExporter
              │
              ├── encode DDSketch → protobuf bytes
              ├── wrap in ClientStatsPayload
              ├── JS msgpack encode
              └── HTTP PUT /v0.6/stats  (Node.js http)
```

```
NATIVE MODE (native spans enabled)
═══════════════════════════════════

  app code
    │
    ▼
  tracer._startSpan()
    │
    ▼
  new NativeDatadogSpan      ←── JS wrapper + Rust storage
    │
    │  span.setTag(k,v)      ←── queues OpCode to WASM change buffer
    │    ├── queueOp(SetMetaAttr, spanId, k, v)
    │    └── (string dedup via string table)
    │
    │  span.finish()
    │    └── queueOp(SetDuration, spanId, ns)
    │
    ▼
  SpanProcessor.process()
    │
    ├── sample()              ←── JS PrioritySampler (same as standard)
    │     └── syncs result → queueOp(SetTraceMetricsAttr, ...)
    ├── gitMetadataTagger()   ←── same, syncs via queueOp(SetTraceMetaAttr)
    │
    ├── for each finished span:
    │     finishedSpans.push(span)
    │     (NO spanFormat call)
    │     (NO JS stats processing)
    │
    └── NativeExporter.export(finishedSpans)
          │
          ▼
        syncTraceTags()       ←── copies trace tags to first span
          │                       via span.context().setTag() → queueOp
          ▼
        flushChangeQueue()    ←── drains all queued OpCodes into Rust spans
          │
          ▼
        flushSpans(spanIds)   ←── sends span IDs to WASM
          │
          ▼
        ┌──────────────────────────────── WASM/Rust ──────────────┐
        │                                                          │
        │  flush_chunk(span_ids)                                   │
        │    │                                                     │
        │    ├── ChangeBufferState.flush_chunk()                   │
        │    │     ├── sets _dd.top_level on local root            │
        │    │     ├── sets _dd.measured on non-internal spans     │
        │    │     ├── copies sampling + trace tags to chunk root  │
        │    │     └── returns Vec<Span> (removes from storage)    │
        │    │                                                     │
        │    ├── StatsCollector.add_spans(spans)                   │
        │    │     │                                               │
        │    │     └── for each eligible span:                     │
        │    │           SpanConcentrator.add_span()               │
        │    │             ├── check top_level || measured || kind  │
        │    │             ├── bucketTime = align(endTime, 10s)    │
        │    │             ├── aggKey from span fields              │
        │    │             ├── hits++, errors++, duration +=        │
        │    │             ├── okDistribution.accept(dur)  ← Rust DDSketch
        │    │             └── errDistribution.accept(dur) ← Rust DDSketch
        │    │                                                     │
        │    ├── TraceExporter.send_trace_chunks_async()           │
        │    │     ├── Rust msgpack serialize spans                │
        │    │     └── HTTP POST /v0.4/traces  (via WASM→Node.js) │
        │    │                                                     │
        └────┼─────────────────────────────────────────────────────┘
             │
             ▼  (every 10s, JS setInterval → WASM)
        ┌──────────────────────────────── WASM/Rust ──────────────┐
        │                                                          │
        │  flushStats(force)                                       │
        │    ├── SpanConcentrator.flush(now, force)                │
        │    │     └── returns Vec<ClientStatsBucket>              │
        │    ├── encode_stats_payload()                            │
        │    │     └── builds ClientStatsPayload protobuf struct   │
        │    ├── rmp_serde::to_vec_named()                         │
        │    │     └── Rust msgpack encode                         │
        │    └── HTTP PUT /v0.6/stats  (via WASM→Node.js)         │
        │                                                          │
        └──────────────────────────────────────────────────────────┘
```

```
WHAT MOVED FROM JS TO RUST
═══════════════════════════

  Component              Standard Mode    Native Mode
  ─────────────────────  ──────────────   ────────────
  Span tag storage       JS ._tags        Rust ChangeBufferState
  spanFormat()           JS (every span)  ELIMINATED
  Trace serialization    JS msgpack       Rust msgpack
  Trace HTTP transport   Node.js http     Rust → WASM → Node.js http
  Stats eligibility      JS               Rust SpanConcentrator
  Stats aggregation      JS DDSketch      Rust DDSketch (libdd-ddsketch)
  Stats time bucketing   JS               Rust SpanConcentrator
  Stats encoding         JS msgpack+pb    Rust rmp-serde + prost
  Stats HTTP transport   Node.js http     Rust → WASM → Node.js http

  Still in JS (both modes):
  ─────────────────────────
  Priority sampling      JS PrioritySampler (rules, agent rates, limiter)
  Trace completeness     JS (started.length === finished.length)
  Git metadata tagging   JS (static values, synced to Rust via OpCode)
  Trace bookkeeping      JS (started/finished arrays, _erase)
```
