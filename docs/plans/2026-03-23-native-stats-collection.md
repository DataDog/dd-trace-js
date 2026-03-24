# Native Stats Collection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate `spanFormat()` from the native spans pipeline by moving stats aggregation (DDSketch + concentrator) into the Rust/WASM layer, where all span data already lives.

**Architecture:** `libdatadog` already has `SpanConcentrator` (in `libdd-trace-stats`) and `StatsExporter` (in `libdd-data-pipeline`) that do exactly what the JS `SpanStatsProcessor` does — bucket spans by time, aggregate by key, maintain DDSketch distributions, and flush to `/v0.6/stats`. The `TraceExporter` already optionally runs a stats worker. The pipeline WASM crate just doesn't expose this. We wire it up through three layers: enable stats in the `TraceExporter` config (libdatadog-nodejs), expose `addSpanForStats` + `flushStats` via WASM (libdatadog-nodejs), and call those from `SpanProcessor` instead of `spanFormat()` (dd-trace-js).

**Tech Stack:** Rust (wasm-bindgen), `libdd-trace-stats::SpanConcentrator`, `libdd-data-pipeline::StatsExporter`, `libdd-data-pipeline::TraceExporter`

**Repos involved:**
- `dd-trace-js` (`/Users/bryan.english/dd-trace-js`) — JS-side changes
- `libdatadog-nodejs` (`/Users/bryan.english/libdatadog-nodejs`, yarn-linked) — WASM bridge changes
- `libdatadog` (upstream, branch `bengl/capability-on-change-buffer`) — may need changes if `TraceExporter` doesn't expose stats config cleanly; investigate first

---

## Context: Current Architecture

```
NATIVE MODE TODAY (spanFormat still called for stats):

  span.finish()
       │
       ▼
  SpanProcessor.process()
       │
       ├──► finishedSpans → NativeExporter → Rust serialize + HTTP
       │
       └──► spanFormat(span)  ◄── EXPENSIVE: full JS formatting
                │
                ▼
            _stats.onSpanFinished(formattedSpan)  ◄── JS DDSketch + aggregation
                │
                ▼  (every 10s)
            JS msgpack encode → PUT /v0.6/stats
```

```
NATIVE MODE AFTER (no spanFormat, stats in Rust):

  span.finish()
       │
       ▼
  SpanProcessor.process()
       │
       ├──► finishedSpans → NativeExporter → Rust serialize + HTTP
       │                                          │
       └──► nativeSpans.addSpanForStats(spanId) ──┘
                                                   │
                                                   ▼
                                    Rust: SpanConcentrator.add_span()
                                    Rust: DDSketch aggregation
                                           │
                                           ▼  (every 10s, in Rust)
                                    Rust: StatsExporter.flush()
                                    Rust: msgpack + protobuf encode
                                    Rust: PUT /v0.6/stats
```

## Context: Existing Rust Crate APIs

### `libdd-trace-stats::SpanConcentrator`
- `new(bucket_size, now, span_kinds_stats_computed, peer_tag_keys)` — create concentrator
- `add_span(&mut self, span: &T) where T: StatSpan` — add a span for aggregation
- `flush(&mut self, now, force) -> Vec<ClientStatsBucket>` — flush aged-out buckets

### `StatSpan` trait (what the concentrator needs per span)
- `service()`, `resource()`, `name()`, `type()` — string fields
- `start()`, `duration()` — i64 timestamps
- `is_error()`, `is_trace_root()`, `is_measured()`, `has_top_level()`, `is_partial_snapshot()` — bool flags
- `get_meta(key)`, `get_metrics(key)` — arbitrary tag lookups

### `libdd-data-pipeline::TraceExporter`
- Already has `stats: Option<PausableWorker<StatsExporter>>` field
- Already starts a stats worker when configured
- `StatsExporter` wraps `SpanConcentrator` + HTTP transport + payload encoding

### `ChangeBufferState` (already in pipeline crate)
- Stores all span data in Rust memory (name, service, resource, type, error, start, duration, meta, metrics)
- Already accessible from `WasmSpanState.change_buffer_state`

---

## Phase 1: libdatadog-nodejs — Expose Stats via WASM

### Task 1: Investigate TraceExporter stats configuration

**Files:**
- Read: `~/.cargo/git/checkouts/libdatadog-fb268e227e330049/3531347/libdd-data-pipeline/src/trace_exporter/mod.rs`
- Read: `~/.cargo/git/checkouts/libdatadog-fb268e227e330049/3531347/libdd-data-pipeline/src/trace_exporter/stats.rs`
- Read: `~/.cargo/git/checkouts/libdatadog-fb268e227e330049/3531347/libdd-data-pipeline/src/stats_exporter.rs`

- [ ] **Step 1: Determine how to enable stats on TraceExporter**

The `TraceExporter` already has a stats worker. Determine:
1. What config/builder options enable it?
2. Does `TraceExporter::send_trace_chunks_async()` (used by `flush_chunk`) automatically feed spans to stats?
3. Or must spans be explicitly added to the concentrator?
4. Does stats flush happen automatically on a timer, or must it be triggered?

Document answers before proceeding. If `TraceExporter` already feeds spans to stats when the stats worker is enabled, Phase 1 may just be "pass the right config flags."

- [ ] **Step 2: Document the integration approach**

Based on findings, determine which of these approaches to take:

**Approach A — TraceExporter auto-stats:** If enabling stats on `TraceExporter` causes `send_trace_chunks_async` to automatically aggregate stats from the spans it sends, we only need to pass the right config when constructing `WasmSpanState`. No new WASM methods needed. Stats flush happens on the Rust timer.

**Approach B — Manual concentrator:** If stats must be fed separately, add a `SpanConcentrator` to `WasmSpanState` and expose:
- `addSpanForStats(spanId: &[u8])` — reads span data from `ChangeBufferState`, wraps it as `StatSpan`, feeds to concentrator
- `flushStats()` — flushes concentrator, encodes payload, sends to `/v0.6/stats`

**Approach C — Hybrid:** Stats worker exists but spans must be explicitly passed. Expose a method to feed span IDs to the concentrator, let the Rust timer handle flushing.

### Task 2: Implement the `StatSpan` adapter

**Files:**
- Create: `/Users/bryan.english/libdatadog-nodejs/crates/pipeline/src/stats.rs`
- Modify: `/Users/bryan.english/libdatadog-nodejs/crates/pipeline/src/lib.rs`

The `SpanConcentrator::add_span()` requires a `StatSpan` trait impl. The span data lives in `ChangeBufferState`. We need an adapter struct that reads from the change buffer and implements `StatSpan`.

- [ ] **Step 1: Create stats.rs with the adapter struct**

```rust
// crates/pipeline/src/stats.rs
use libdd_trace_stats::span_concentrator::stat_span::StatSpan;
use libdd_trace_utils::change_buffer::ChangeBufferState;

/// Adapter that reads span data from ChangeBufferState and presents it
/// via the StatSpan trait for the SpanConcentrator.
pub struct ChangeBufferStatSpan<'a> {
    state: &'a ChangeBufferState,
    span_id: u64,
    // Cache fields read from change buffer to satisfy lifetime requirements
    service: String,
    resource: String,
    name: String,
    span_type: String,
    start: i64,
    duration: i64,
    error: i32,
    meta: HashMap<String, String>,    // only the keys stats needs
    metrics: HashMap<String, f64>,
}
```

The exact field access API depends on `ChangeBufferState`'s public interface — the getter methods on `WasmSpanState` (like `get_service_name`, `get_meta_attr`, etc.) show the pattern. The adapter should pre-read the needed fields.

- [ ] **Step 2: Implement the StatSpan trait**

Implement all required methods. The stats concentrator needs: `service`, `resource`, `name`, `type`, `start`, `duration`, `is_error`, `is_trace_root`, `is_measured`, `has_top_level`, `is_partial_snapshot`, `get_meta`, `get_metrics`.

Key meta keys needed: `http.status_code`, `http.route`, `http.endpoint`, `http.method`, `_dd.origin`, `span.kind`.
Key metric keys needed: `_dd.top_level`, `_dd.measured`.

- [ ] **Step 3: Write a unit test for the adapter**

Test that a span created via change buffer operations can be read back correctly through the `StatSpan` trait.

### Task 3: Expose stats methods on WasmSpanState

**Files:**
- Modify: `/Users/bryan.english/libdatadog-nodejs/crates/pipeline/src/lib.rs`
- Modify: `/Users/bryan.english/libdatadog-nodejs/crates/pipeline/Cargo.toml`

- [ ] **Step 1: Add `libdd-trace-stats` dependency to Cargo.toml**

```toml
libdd-trace-stats = { git = "https://github.com/DataDog/libdatadog.git", branch = "bengl/capability-on-change-buffer", default-features = false }
```

- [ ] **Step 2: Add concentrator + stats exporter fields to WasmSpanState**

```rust
use libdd_trace_stats::span_concentrator::SpanConcentrator;

pub struct WasmSpanState {
    change_buffer_state: ChangeBufferState,
    exporter: TraceExporter,
    // NEW:
    concentrator: Option<SpanConcentrator>,
}
```

- [ ] **Step 3: Add constructor parameter to enable stats**

Add a `stats_enabled: bool` (and optionally `stats_bucket_size_secs: u32`) parameter to `WasmSpanState::new()`. When enabled, create a `SpanConcentrator` with the appropriate bucket size and empty span_kinds/peer_tags (these can be configured later via setter methods if needed).

- [ ] **Step 4: Expose `addSpanForStats` WASM method**

```rust
#[wasm_bindgen(js_name = "addSpanForStats")]
pub fn add_span_for_stats(&mut self, id: &[u8]) -> Result<(), JsValue> {
    if let Some(concentrator) = &mut self.concentrator {
        // Flush change queue first to ensure span data is up to date
        self.change_buffer_state.flush_change_buffer()
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        let span = ChangeBufferStatSpan::from_state(&self.change_buffer_state, id)?;
        concentrator.add_span(&span);
    }
    Ok(())
}
```

- [ ] **Step 5: Expose `flushStats` WASM method**

```rust
#[wasm_bindgen(js_name = "flushStats")]
pub async fn flush_stats(&mut self, force: bool) -> Result<JsValue, JsValue> {
    if let Some(concentrator) = &mut self.concentrator {
        let buckets = concentrator.flush(SystemTime::now(), force);
        if buckets.is_empty() {
            return Ok(JsValue::NULL);
        }
        // Encode as ClientStatsPayload and send to /v0.6/stats
        // Use the same HTTP transport as trace export
        let payload = encode_stats_payload(buckets, &self.metadata);
        let encoded = rmp_serde::to_vec(&payload)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        // Send via HTTP...
    }
    Ok(JsValue::NULL)
}
```

Note: The exact encoding/transport depends on what `libdd-data-pipeline` exposes. If `StatsExporter` handles HTTP internally, we may be able to reuse it directly. If not, we encode + send using the existing HTTP capability.

- [ ] **Step 6: Build and test the WASM module**

```bash
cd /Users/bryan.english/libdatadog-nodejs
wasm-pack build crates/pipeline --target web
```

Verify the new methods appear in `prebuilds/pipeline/pipeline.d.ts`.

### Task 4: Update TypeScript declarations

**Files:**
- Modify: `/Users/bryan.english/libdatadog-nodejs/prebuilds/pipeline/pipeline.d.ts`

- [ ] **Step 1: Add new method signatures**

After building, verify the generated `.d.ts` includes:
```typescript
addSpanForStats(id: Uint8Array): void;
flushStats(force: boolean): Promise<any>;
```

---

## Phase 2: dd-trace-js — Use Native Stats

### Task 5: Wire up native stats in NativeSpansInterface

**Files:**
- Modify: `packages/dd-trace/src/native/native_spans.js`

- [ ] **Step 1: Add `addSpanForStats` wrapper method**

```javascript
/**
 * Feed a finished span into the native stats concentrator.
 * @param {BigInt} spanId - The native span ID
 */
addSpanForStats (spanId) {
  if (!this._state) return
  const buf = new Uint8Array(8)
  const view = new DataView(buf.buffer)
  view.setBigUint64(0, spanId, true)
  this._state.addSpanForStats(buf)
}
```

- [ ] **Step 2: Add `flushStats` wrapper method**

```javascript
/**
 * Flush aggregated stats to the agent.
 * @param {boolean} force - Force flush all buckets (for shutdown)
 * @returns {Promise<void>}
 */
async flushStats (force = false) {
  if (!this._state) return
  await this._state.flushStats(force)
}
```

- [ ] **Step 3: Add a stats flush interval**

In the constructor or an init method, start a 10-second interval that calls `flushStats(false)`. Register a `beforeExit` handler that calls `flushStats(true)`.

### Task 6: Update NativeExporter to pass stats config

**Files:**
- Modify: `packages/dd-trace/src/exporters/native/index.js`

- [ ] **Step 1: Pass stats_enabled to NativeSpansInterface**

When constructing the `WasmSpanState` in `NativeSpansInterface`, pass `stats_enabled: true` if `config.stats.enabled` is set. This ensures the Rust-side `SpanConcentrator` is created.

### Task 7: Remove `spanFormat` from native mode in SpanProcessor

**Files:**
- Modify: `packages/dd-trace/src/span_processor.js`

- [ ] **Step 1: Replace the stats branch in native mode**

Change the native mode branch from:

```javascript
// BEFORE: formats span in JS just for stats
if (this._stats) {
  const formattedSpan = spanFormat(span, isFirstSpanInChunk, this._processTags)
  isFirstSpanInChunk = false
  this._stats.onSpanFinished(formattedSpan)
}
```

To:

```javascript
// AFTER: feed span directly to native stats (no JS formatting)
if (this._nativeSpans && this._isNativeStatsEnabled) {
  const spanId = span.context()._nativeSpanId
  if (spanId !== undefined) {
    this._nativeSpans.addSpanForStats(spanId)
  }
}
```

- [ ] **Step 2: Add `_isNativeStatsEnabled` flag**

Set this in the constructor based on whether both native mode and stats computation are enabled:

```javascript
this._isNativeStatsEnabled = this._isNativeMode && config.stats?.enabled
```

- [ ] **Step 3: Keep JS stats for non-native mode**

The existing `this._stats` (JS `SpanStatsProcessor`) remains active for non-native mode. Only skip it when native stats are handling it.

- [ ] **Step 4: Run tests to verify no `spanFormat` call in native mode**

```bash
DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED=true DD_TRACE_STATS_COMPUTATION_ENABLED=true \
  ./node_modules/.bin/mocha --timeout 30000 packages/dd-trace/test/span_processor.spec.js
```

### Task 8: Add integration test

**Files:**
- Create or modify: `packages/dd-trace/test/exporters/native/stats.spec.js`

- [ ] **Step 1: Write a test that verifies stats are sent via native path**

Set up a mock agent that listens for `PUT /v0.6/stats`. Create native spans, finish them, trigger stats flush, and verify the mock agent received a valid `ClientStatsPayload` with correct aggregation keys and DDSketch summaries.

- [ ] **Step 2: Write a test that verifies `spanFormat` is NOT called in native mode with stats**

Stub/spy on `spanFormat` and verify it's never called when both native mode and stats computation are enabled.

---

## Phase 3: Cleanup (can be a follow-up PR)

### Task 9: Remove JS stats code path for native mode

**Files:**
- Modify: `packages/dd-trace/src/span_processor.js` — remove `this._stats` initialization when native stats are enabled
- No deletion of `span_stats.js` etc. — still needed for non-native mode

- [ ] **Step 1: Skip JS SpanStatsProcessor creation when native stats handle it**

In the SpanProcessor constructor, don't create the JS `SpanStatsProcessor` or `SpanStatsExporter` when `_isNativeStatsEnabled` is true.

---

## Open Questions (to resolve during Task 1)

1. **Does `TraceExporter.send_trace_chunks_async` auto-feed spans to stats?** If yes, we may not need `addSpanForStats` at all — just enabling the stats worker on TraceExporter config may be sufficient. This would eliminate Tasks 2-3 and simplify Task 7.

2. **How does `StatsExporter` send HTTP?** It may use the same capability-based HTTP that traces use, in which case no new transport code is needed.

3. **Does `ChangeBufferState` expose per-span field reads?** The WASM getters on `WasmSpanState` (like `get_service_name(id)`) flush the change buffer then read. We need the same access internally in Rust without going through WASM bindings.

4. **Timer in WASM:** The stats flush needs a 10-second timer. WASM can't do `setInterval`. Options: (a) JS-side `setInterval` that calls `flushStats()`, (b) flush stats as part of `flush_chunk()` calls. Option (a) is simpler and matches the JS implementation.

5. **`_dd.top_level` and `_dd.measured` metrics:** These are set by `spanFormat()` in JS. In native mode without `spanFormat`, who sets them? They need to be set as metric attributes on the span before stats can read them. Check if the native span creation path already sets these, or if we need to add OpCodes for them.
