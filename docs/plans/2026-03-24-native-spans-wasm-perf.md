# Native Spans WASM Performance Optimization Plan

**Goal:** Reduce the ~7x native span overhead vs JS spans by minimizing DataView writes to WASM linear memory and reducing per-operation parsing cost in Rust.

**Problem:** Profiling shows 55% of native span time is in V8's WASM memory access layer (`node::sea::GetAsset`), triggered by individual `DataView.setUint32()` calls into WASM linear memory. Each bare span requires ~27 DataView writes; a span with 10 tags requires ~67. The 16-byte header (opcode + spanId) is repeated per operation, consuming 40-80% of buffer bandwidth.

**Approach:** Three independent optimizations, each deliverable as a separate PR.

---

## Current State: Per-Span Buffer Writes

```
Bare span (create + name + start + finish):
  Create:      [op:8][sid:8][tid:16][pid:8]    = 40 bytes, ~13 writes
  SetName:     [op:8][sid:8][strId:4]           = 20 bytes,   4 writes
  SetStart:    [op:8][sid:8][ns:8]              = 24 bytes,   5 writes
  SetDuration: [op:8][sid:8][ns:8]              = 24 bytes,   5 writes
  ─────────────────────────────────────────────────────────────────
  Total:       108 bytes, 27 writes, 4 Rust HashMap lookups

10-tag span (above + 10 × SetMetaAttr):
  10×Meta:     10 × [op:8][sid:8][key:4][val:4] = 240 bytes, 40 writes
  ─────────────────────────────────────────────────────────────────
  Total:       348 bytes, 67 writes, 14 Rust HashMap lookups
```

Each write is a `DataView.setUint32(offset, value, true)` against WASM linear
memory, which V8 bounds-checks on every call.

---

## Optimization 1: Stage in JS, Copy Once

**Impact: High — eliminates ~90% of DataView writes to WASM memory**

Instead of writing each field directly to WASM memory via DataView, stage the
entire operation sequence in a regular JS `ArrayBuffer`, then copy the complete
buffer into WASM memory with a single `Uint8Array.set()` call.

### JS Side Changes

**Files:** `packages/dd-trace/src/native/native_spans.js`

Replace the per-field DataView writes in `queueOp` with writes to a local
staging buffer:

```js
// Before (27+ DataView writes to WASM memory per span):
view.setUint32(idx, op, true)        // WASM write
view.setUint32(idx + 4, 0, true)     // WASM write
buf.set(spanId, idx + 8)             // WASM write
view.setUint32(idx + 16, strId, true) // WASM write
...

// After (1 copy to WASM memory per queueOp call):
stagingView.setUint32(pos, op, true)        // JS memory write (fast)
stagingView.setUint32(pos + 4, 0, true)     // JS memory write
stagingBuf.set(spanId, pos + 8)             // JS memory write
stagingView.setUint32(pos + 16, strId, true) // JS memory write
...
wasmBuf.set(stagingBuf.subarray(0, pos), idx) // single WASM write
```

Implementation:
- [ ] Allocate a JS-side `ArrayBuffer` (e.g. 4KB) as a staging buffer in the constructor
- [ ] Create a `DataView` and `Uint8Array` over it (these are fast — no WASM bounds checks)
- [ ] In `queueOp`, write all fields to the staging buffer
- [ ] At the end of `queueOp`, do a single `wasmBuf.set(stagingSlice, wasmIdx)` to copy
- [ ] Same for `queueBatchMeta` and `queueBatchMetrics` — stage the entire batch, copy once

### Rust Side Changes

None. The wire format is identical.

### Expected Improvement

A bare span goes from 27 WASM DataView writes to 4 `Uint8Array.set()` calls
(one per op: Create, SetName, SetStart, SetDuration). A 10-tag span goes from
67 writes to 14 set calls. Each `set()` copies a contiguous chunk of bytes,
which V8 can optimize as a `memcpy` rather than individual bounds-checked writes.

For the batch methods, 10 tags go from 40 WASM writes to 1 `set()` call.

---

## Optimization 2: Combined `CreateSpan` Opcode

**Impact: Medium — reduces per-span ops from 4 to 1-2 for common cases**

Add a new opcode that combines Create + SetName + SetStart into a single
operation, since every span needs all three.

### Wire Format

```
OpCode 13 — CreateSpan (variable size)
[OpCode=13 : u64][SpanID : u64][TraceID : u128][ParentID : u64]
[Name : u32 strId][Start : i64]
```

Total: 56 bytes (vs 84 bytes for Create+SetName+SetStart = 40+20+24)

Optional extension — include service + resource + type if present:

```
OpCode 14 — CreateSpanFull (variable size)
[OpCode=14 : u64][SpanID : u64][TraceID : u128][ParentID : u64]
[Name : u32][Service : u32][Resource : u32][Type : u32][Start : i64]
```

Total: 72 bytes. This replaces Create+SetName+SetService+SetResource+SetType+SetStart
(40+20+20+20+20+24 = 144 bytes, 6 ops → 1 op).

### Rust Side Changes

**Files:**
- `libdd-trace-utils/src/change_buffer/operation.rs` — add `CreateSpan = 13` and `CreateSpanFull = 14` to the enum
- `libdd-trace-utils/src/change_buffer/mod.rs` — add match arms in `interpret_operation`

```rust
OpCode::CreateSpan => {
    let trace_id: u128 = self.get_num_arg(index)?;
    let parent_id: u64 = self.get_num_arg(index)?;
    let name = self.get_string_arg(index)?;
    let start: i64 = self.get_num_arg(index)?;
    let mut span = T::new_span(span_id, trace_id, parent_id);
    span.name = name;
    span.start = start;
    self.spans.insert(span_id, span);
    // ... trace bookkeeping same as Create
}
```

### JS Side Changes

**Files:** `packages/dd-trace/src/native/span.js`, `native_spans.js`

- [ ] Add `queueCreateSpan(spanId, traceId, parentId, name, startNs)` method
- [ ] Use it in `NativeDatadogSpan` constructor instead of separate Create + SetName + SetStart ops
- [ ] For `CreateSpanFull`, also pass service/resource/type when available in initial tags

### Expected Improvement

Bare span: 4 ops → 2 ops (CreateSpan + SetDuration). Eliminates 2 opcode
headers (32 bytes), 2 span ID lookups in Rust, and 2 HashMap lookups.

With service+resource+type: 7 ops → 2 ops (CreateSpanFull + SetDuration).
Eliminates 5 headers (80 bytes) and 5 HashMap lookups.

---

## Optimization 3: Batch Meta Opcode

**Impact: Medium — reduces per-tag overhead for bulk tag writes**

Add a new opcode that encodes N meta tags for a single span in one operation,
eliminating the repeated 16-byte header per tag.

### Wire Format

```
OpCode 15 — BatchSetMeta
[OpCode=15 : u64][SpanID : u64][Count : u32][
  [KeyStringID : u32][ValueStringID : u32]   ← repeated Count times
]
```

For 10 tags: 16 (header) + 4 (count) + 10 × 8 (key+val) = 100 bytes
vs current: 10 × 24 = 240 bytes (58% reduction)

Similarly for metrics:

```
OpCode 16 — BatchSetMetric
[OpCode=16 : u64][SpanID : u64][Count : u32][
  [KeyStringID : u32][Value : f64]           ← repeated Count times
]
```

### Rust Side Changes

**Files:** Same as Optimization 2.

```rust
OpCode::BatchSetMeta => {
    let count: u32 = self.get_num_arg(index)?;
    let span = self.spans.get_mut(&span_id)
        .ok_or(ChangeBufferError::SpanNotFound(span_id))?;
    for _ in 0..count {
        let key = self.get_string_arg(index)?;
        let val = self.get_string_arg(index)?;
        span.meta.insert(key, val);
    }
}
```

### JS Side Changes

**Files:** `native_spans.js`

Update `queueBatchMeta` to use the new opcode format — write the header once,
then just key+val pairs.

### Expected Improvement

10-tag batch: 10 ops → 1 op. One Rust span lookup (HashMap get) instead of
10. Buffer writes reduced from 40 to 24 (header + count + 10 × 2 u32s).

Combined with Optimization 1 (staging buffer), this becomes a single
`Uint8Array.set()` of 100 bytes instead of 40 individual DataView writes.

---

## Optimization Priority and Dependencies

```
                                   Estimated    Depends
Optimization                       Impact       On
──────────────────────────────────────────────────────────
1. Stage in JS, copy once          ~40-50%      nothing
2. Combined CreateSpan opcode      ~15-20%      libdatadog PR
3. Batch meta/metric opcode        ~10-15%      libdatadog PR
──────────────────────────────────────────────────────────
Combined                           ~50-65%
```

Optimization 1 is pure JS (no Rust changes) and can ship immediately. It
reduces the number of V8 WASM-memory-crossing writes by ~90%.

Optimizations 2 and 3 require a libdatadog PR to add new opcodes to the change
buffer protocol. They can be done together in one PR since they touch the same
files. The JS changes are straightforward once the Rust side is in place.

---

## Validation

After each optimization:
- [ ] Run `node benchmark/sirun/native-spans/verify.js` in both modes
- [ ] Run the full sirun benchmark suite and compare against the baseline:

```
Baseline (current):
                                        JS        Native     Ratio
──────────────────────────────────────────────────────────────────────
Creation, bare              (1M)      0.83 s      5.82 s      7.0x
Creation, 10 tags           (1M)      0.93 s      9.58 s     10.3x
Tagging, 5× setTag          (1M)      1.69 s      9.20 s      5.4x
Parent-child, 3 deep      (500K)      1.18 s      9.39 s      8.0x
Parent-child, 10 deep     (500K)      3.66 s     29.97 s      8.2x
getTag, 3 reads             (1M)      0.16 s      0.20 s      1.3x
Pipeline                  (200K)      0.21 s      7.16 s     34.1x
──────────────────────────────────────────────────────────────────────
```

Target after all three optimizations: **2-3x** overhead instead of 7-10x.
