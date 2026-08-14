# Native Spans PoC: moving `Span` into a Rust native extension

**Status:** PoC design. Not shipped, not backported, no telemetry/docs/`supported-configurations.json`
entries. Unit tests are expected to fail and other products (appsec, profiling, debugger, llmobs, CI
Visibility) are expected to break while the flag is on — accepted for the duration of this PoC.

## Motivation

Every `Span` method currently does real work in JS: storing tags in an object, tracking timing,
appending to arrays, mutating shared trace state. This PoC tests how fast the tracer can go if `Span`
does none of that — every method call becomes a fixed-width write into a shared buffer, and a Rust
native extension takes over decoding, trace assembly, encoding, and export entirely off the JS thread.

## Goals

- Prove out a `Span` implementation where every mutating method is a buffer write, not a data
  structure mutation.
- Move msgpack v0.5 encoding to Rust; move HTTP export to Rust and off the JS main thread. Decode,
  chunk assembly, and encoding run in Rust but stay synchronous with the flushing call — only the
  network write is offloaded (see "Decode, process, encode" below for why).
- Make the JS write path as fast as possible — explicitly prioritized over Rust-side speed.
- Keep the existing implementation fully intact and selectable via a flag, so both can be benchmarked
  side by side.

## Non-goals (accepted PoC limitations)

- Sampling is ignored. Every span that completes is exported.
- Only `Span`/`SpanContext` are reimplemented. Nothing that reads span state through baggage getters,
  tag getters, or other products' hooks is expected to keep working.
- No telemetry, no docs, no `supported-configurations.json`, no backport — this never ships.
- Byte-for-byte trace equivalence isn't a goal; structural equivalence (same spans, same tags, same
  shape) is, via the parity harness below.

## Architecture overview

```
Span method call (JS)
  -> EventWriter: dedicated write method per event kind, fixed-width record into a shared buffer
  -> flush (every ~1s or ~16MB): one synchronous napi call, still on the JS thread
       -> decode (two-pass) -> process (chunk assembly) -> encode (v0.5)   [inline, blocking]
       -> hand the finished payload to an async task                      [off-thread]
            -> HTTP PUT to agent
```

Everything up to and including encode runs synchronously on the JS thread that called `flush()` — its
cost is real, measured time, not hidden off-thread. Only the HTTP PUT itself is deferred, matching how
the current JS implementation already works: `_encoder.makePayload()` runs synchronously today too
([writer.js:33](../../../packages/dd-trace/src/exporters/common/writer.js#L33)), and only the request
itself is non-blocking. Doing decode/process/encode on a separate thread would make the comparison
easier than the one the baseline actually faces, and would risk hiding real per-request cost from the
reqs/s benchmark.

## Flag

`DD_TRACE_EXPERIMENTAL_NATIVE_SPANS` (boolean env var), same convention as
`DD_TRACE_EXPERIMENTAL_STATE_TRACKING`. Minimal plumbing only: a `defaults.js` entry and an
`#applyEnvironment()` mapping. No telemetry name mapping, no docs, no supported-configurations entry —
those steps are for real public options, and this one never ships.

When set, the span-construction call site swaps `new DatadogSpan(...)` for `new NativeSpan(...)`.
`NativeSpan` implements the same public method surface as today's `Span`, so nothing above the
construction point needs to know which implementation it got.

## JS side: `Span` / `EventWriter`

### Retained per-context state

`NativeSpanContext` keeps exactly four fields: **trace ID, segment ID, span ID, parent span ID**.
Nothing else — no tag map, no sampling object, no links/events arrays, no stored start time. Every
mutation is a direct write into the shared buffer, never a field kept for later read-back.

"Segment" maps onto today's "chunk" concept in `span_format.js` — the set of spans sharing one local
trace root (one `_trace` object in `span_context.js`).

### `id.js` rewrite

IDs and nanosecond timestamps are stored as **two `Uint32Array` lanes (hi/lo)**, not `BigUint64Array`.
A reproduced, correctness-verified microbenchmark showed `Uint32Array` hi/lo pairs are **~6-8.5x
faster** than `BigUint64Array` for this access pattern once embedded in realistic, interleaved,
class-method-based code — the initial "roughly equal" read was a microbenchmark trap that didn't hold
once the comparison matched real call shape.

A 128-bit trace ID extends this to **four `Uint32Array` lanes** (upper-64 hi/lo, lower-64 hi/lo).

`Identifier#toBigInt()` / `#toString()` stay as today's lazy-cached cold-path methods, for the rare
call sites (propagation headers, `toTraceId()`, logging) that still need string/BigInt forms. The hot
path (`EventWriter` record fill) reads the lanes directly and never constructs a `BigInt`.

Today, `span._startTime`/`_duration` are kept as floating-point milliseconds and only rounded to
integer nanoseconds at format/encode time (`span_format.js`'s `Math.round(value * 1e6)`). That deferred
rounding has nowhere to live in this design — "Retained per-context state" above keeps no start time
field to round later, so the round-to-integer-nanoseconds step must happen inline, at the moment
`SPAN_START`/`FINISH`/`ADD_EVENT` is written, immediately splitting the result into the `Uint32Array`
hi/lo lanes. Nothing is ever stored as a float on the JS side.

### String interning

Interning is scoped to a single flush window, not the process lifetime — a persistent table would grow
without bound over a long-running process, and in a real app with meaningful string cardinality (URLs,
request-specific tag values, etc.) its size would itself become a significant, unbounded consumer of
memory on top of the already-bounded 16MB event/doubles/string buffers.

The JS-side `Map<string, id>` is cleared after every flush; ids are only unique within the window that
just ended and get reused (restarting from 1) in the next window. Rust never keeps a persistent string
table either — each flush batch gets its own small, local id→string lookup, built while decoding that
batch and discarded once the batch is fully processed and encoded.

The wire format is unchanged: the first time any string is used within a window (tag key, tag string
value, span/service/resource/type name, serialized link/event attributes), it emits a `REGISTER_STRING`
record — `[type, stringId, byteLength]` in the `Uint32Array` view — followed by `byteLength` raw UTF-8
bytes appended to that window's string blob. Decode is still positional within the batch: registration
order in the event log matches byte order in the string blob, so no explicit offset field is needed.

**Cost of resetting.** Recurring low-cardinality strings — tag keys, service names, common operation
names — get re-registered once per flush window instead of once ever. This is bounded and small (it
scales with the number of distinct recurring strings, not with span/tag volume) and is worth paying for
a hard cap on memory. To avoid paying it for the *most* common keys specifically, a small set of
well-known tag keys (`service`, `resource`, `type`, `name`, `error.message`, `error.type`,
`error.stack`, and similarly universal keys) get fixed, reserved ids baked into both JS and Rust at
build time — outside the resettable range entirely, needing no `REGISTER_STRING` traffic ever, at any
frequency.

**Values that outlive a window.** Chunk assembly can span multiple flush batches (a segment can still
be open when a flush fires). Anything that must survive past the batch it arrived in — the process-level
defaults from `PROCESS_INFO`, or a started-but-unfinished span's already-set tags — is resolved to its
owned string value immediately during that batch's decode, before its window's table is discarded.
Nothing persists across batches by reference to an id.

This is also how default-value inheritance (constraint: info inferable at a higher level shouldn't
repeat per span) falls out for free with zero special-casing: `setTag('service.name', x)` is an
ordinary `SET_TAG_STRING` event; Rust already has a process-level default service from `PROCESS_INFO`,
and during chunk assembly uses the per-span override if one arrived for that span id, else the default.

### Event tiers

- **Process-level** (`PROCESS_INFO`, once at init): default service, env, version, language, pid.
- **Trace-level** (once per distributed trace): 128-bit trace ID, origin.
- **Segment-level** (`SEGMENT_START`, once per local trace root): segment id → trace id, segment-scoped
  tags — replaces `extractChunkTags`.
- **Span-level**: name, tags, timing, parent/span id — everything genuinely per-span.

### Event kinds

| Kind | Fields (elided-id form / explicit-id form) |
|---|---|
| `SPAN_START` | `[segmentIdHi, segmentIdLo, spanIdHi, spanIdLo, parentIdHi, parentIdLo, startHi, startLo]` |
| `SET_TAG_STRING` | `[keyId, valueId]` / `[idHi, idLo, keyId, valueId]` |
| `SET_TAG_NUMBER` | `[keyId]` / `[idHi, idLo, keyId]` (value consumed positionally from the doubles buffer, not stored in this record — see below) |
| `ADD_LINK` | `[targetIdHi, targetIdLo, attrsId]` / `[idHi, idLo, targetIdHi, targetIdLo, attrsId]` |
| `ADD_EVENT` | `[nameId, timeHi, timeLo, attrsId]` / `[idHi, idLo, nameId, timeHi, timeLo, attrsId]` |
| `FINISH` | `[durationHi, durationLo]` / `[idHi, idLo, durationHi, durationLo]` |
| `REGISTER_STRING` | `[stringId, byteLength]` (never has an id form — process-global) |
| `PROCESS_INFO` | `[serviceId, envId, versionId, languageId, pid]` (once, no id form) |
| `SEGMENT_START` | `[segmentIdHi, segmentIdLo, traceIdHiHi, traceIdHiLo, traceIdLoHi, traceIdLoLo]` |
| `ENTER_CONTEXT_KEEP_LAST` | `[]` — start treating the elided-id form as referring to the most recent explicit id |
| `ENTER_CONTEXT_NEW` | `[idHi, idLo]` — establish a new entered context, replacing whatever was entered before |

Every field is a `Uint32Array` lane except float64 values, which live in a third buffer — a shared
`Float64Array`-backed **doubles buffer**, not a region of the event log, and not one buffer per
float-carrying kind. `SET_TAG_NUMBER` is the only kind that needs it today, but the mechanism isn't
tied to that kind: any `(kind, entered-state)` pair can be marked in the layout table as consuming *N*
doubles (currently 0 or 1, never more than 1 in this design), and every such record — regardless of
which kind it is — draws its value from the *same* buffer and cursor. Adding a second float-carrying
kind later costs one line in the layout table, not a fourth buffer.

**Why a shared buffer instead of inlining the value in the word stream.** A `Float64Array` view's
elements are only guaranteed 8-byte-aligned relative to that view's *own* fixed origin (the engine
enforces this at construction: a `Float64Array`'s byte offset must itself be a multiple of 8, or the
constructor throws). A float-carrying record's position in the word stream depends on how many
variable-width elided/explicit records preceded it, so its byte offset relative to the *event log's*
start isn't reliably a multiple of 8 — half the time it lands on a 4-byte-odd offset, where no
`Float64Array` view could ever read it. Putting the value in its own buffer, indexed from 0, sidesteps
the problem entirely: every integer index into a `Float64Array` is aligned by construction, regardless
of what's happening in the word stream. Decode consumes it positionally — the *n*th float-carrying
record encountered while walking the word stream reads the *n*th entry from the doubles buffer — the
same trick `REGISTER_STRING` already uses for the string blob, applied to a second, fixed-width payload.
This also drops the value out of the record's own word layout (see `SET_TAG_NUMBER`'s row above), so the
fix shrinks that record by a word instead of just relocating the problem.

**Alternatives considered, with numbers.** Two ways to avoid a third buffer entirely, both keeping the
float inline in the single word/byte stream: (1) reinterpret the float's bits into two `u32` words via a
reused 8-byte scratch buffer (`scratchF64[0] = value; words[i] = scratchU32[0]; words[i+1] =
scratchU32[1]`) — the same hi/lo shape ids and timestamps already use; (2) skip `Float64Array` entirely
and write through a `DataView.setFloat64(byteOffset, value, true)` at the current (possibly unaligned)
byte offset, since `DataView` has no alignment requirement. A microbenchmark (4M writes/trial, 5 trials,
rerun in a fresh process to confirm) put the dedicated-buffer write at ~1.7ms, the scratch-buffer
bit-reinterpret at ~3.0ms (a reproducible ~1.7x slower — the extra store+2 loads+2 stores per write adds
up), and `DataView` at ~1.8-2.1ms (a smaller, but still consistent and reproducible, 5-19% slower). The
dedicated doubles buffer won outright, and it's also the option that needs no bit-manipulation and no
alignment reasoning on either the JS or the Rust side — so it's not just faster, it's simpler.

The constraint this design imposes: dedicated write method per kind (no generic dispatcher), fixed
width per `(kind, entered-state)` pair, IDs/timestamps as `Uint32Array` hi/lo, any float64 field routed
through the shared doubles buffer and consumed positionally, like registered strings.

**Booleans and derived methods, resolved during this write-up** (see "Decisions made while drafting"):
- `setTag(key, true/false)` → `SET_TAG_NUMBER` with `0`/`1`. No dedicated bool event kind.
- `setOperationName(name)`, and tag-based overrides of service/resource/type → `SET_TAG_STRING` with a
  reserved, well-known key id. Rust routes reserved keys into the corresponding top-level formatted-span
  field instead of the generic `meta` map. `SPAN_START` itself carries no name/service/resource/type —
  those are just tags with reserved keys, same mechanism as any other tag.
- `addTags(tags)` → loops, calling `SET_TAG_STRING`/`SET_TAG_NUMBER` once per key. Not its own event kind.
- `addSpanPointer(...)` → a thin JS wrapper that computes link fields and calls the `addLink` write path.
  Not its own event kind.
- `setBaggageItem`/`getBaggageItem`/`getAllBaggageItems`/`context().getTag(...)` → silent no-ops
  (`undefined`/empty), consistent with the getter decision below. Baggage read-back has the same
  "no JS-side state to read from" problem as the tag getters, and out-of-process baggage propagation is
  out of scope for this PoC's test app.

### Identity elision (context bracketing)

Sending a span's own id on every event is redundant when several operations happen back to back on the
same span. Two event kinds bracket a run of operations so the id can be omitted:

- `ENTER_CONTEXT_KEEP_LAST` — 1-word write. Start treating the next elided-id events as referring to
  whichever id was most recently sent explicitly.
- `ENTER_CONTEXT_NEW` — 3-word write. Establish a new entered context directly.

An elided-id record for a given event kind is genuinely shorter on the wire than its explicit-id form —
decode carries one bit of persistent state (mirroring `EventWriter`'s `#enteredContext`) that says
whether the current kind's record should be read in its short or long form.

There is no `LEAVE_CONTEXT` — see below for why finish doesn't need one either.

**Sentinel semantics.** The elided form doesn't carry a literal `0` id field to compare against — the
record is just missing the id lanes. Conceptually, "no id present" means "whatever the entered context
is," which today is always a real span (this PoC only implements `Span`), but in a more general system
could also validly mean "no span active." That ambiguity is scoped away by construction: elision only
ever applies to the *subject* field of a per-span event (whose operation this is), never to a *data*
field that happens to be span-shaped (e.g. `ADD_LINK`'s target, which is always written explicitly
regardless of its value).

**Adaptive entry — the mechanism that makes this a strict improvement, never a regression.**
Unconditionally bracketing every context switch costs `LEAVE`(1) + `ENTER_NEW`(3) = 4 words on a
context switch, which is *worse* than plainly writing the id (2 words) when nothing repeats. To avoid
that, `EventWriter` only pays the entry cost once a repeat is *proven* — by comparing against the
immediately preceding write, not "seen at some point":

```js
if (context === this.#enteredContext) {
  // already amortized — cheapest path
  write(op, /* id omitted */, ...payload)
} else if (context === this.#pendingContext) {
  // second touch in a row for this context — now worth entering
  emit(context === this.#lastExplicitContext ? ENTER_CONTEXT_KEEP_LAST : ENTER_CONTEXT_NEW(context.spanId))
  this.#enteredContext = context
  write(op, /* id omitted */, ...payload)
} else {
  // first touch, no proven locality yet — plain explicit id, no bracketing paid
  write(op, context.spanId, ...payload)
  this.#lastExplicitContext = context
}
this.#pendingContext = context
```

Three private fields: `#enteredContext` (who the elided form currently refers to), `#pendingContext`
(who the *previous* write was for — the "proof" tracker), `#lastExplicitContext` (who most recently got
a real id, enabling the cheap `KEEP_LAST` form).

`SPAN_START` needs no special-casing here: a freshly created context has never been seen before, so it
can never equal `#enteredContext` or `#pendingContext` — it always lands in the "first touch" branch on
its own first write, which is exactly what `SPAN_START` is.

**Why there's no `LEAVE_CONTEXT`, and `finish` needs no special case either.** An earlier draft of this
algorithm emitted a `LEAVE_CONTEXT` before entering a *different* context, and another eagerly emitted
one on `finish`, on the theory that a stale `#enteredContext` was a bug risk. Neither is true:
`ENTER_CONTEXT_KEEP_LAST`/`ENTER_CONTEXT_NEW` *unconditionally overwrite* the entered context on decode
— they never need a preceding `LEAVE` to be correct, whatever was entered before is simply replaced.
And `#enteredContext` holds a specific `SpanContext` object reference; `context === this.#enteredContext`
can only ever be true for the exact same object, never for an unrelated span, so a stale reference to an
already-finished span is harmless by construction — it can never be mistaken for a different span, and
the only context it *could* still validly refer to is the one it already correctly refers to. So
`finish` is not a special case at all: it goes through `ensureContextAndWrite` exactly like every other
per-span event, with no follow-up write.

Worked examples:
- `spanStart → tag → tag → finish`: 1 bracketing write total (`ENTER_CONTEXT_KEEP_LAST`, entered on the
  second touch and never re-entered) vs. 6 baseline id-writes (2 words × 3 id-carrying ops after the
  first).
- Fully interleaved, one operation per span, never repeating (`A, B, C, ...`): every write lands in the
  "first touch" branch since nothing ever repeats adjacently. Cost matches the plain always-explicit
  baseline exactly. This is the property that makes the mechanism worth adopting unconditionally: the
  worst case is a tie with not having it at all, never a loss.
- `A, A, B, A, A` (an unrelated span touched in the middle of a repeat run): costs 5 words total — the
  first `A` touch is explicit (2), the second enters (1) and writes for free (0), `B`'s single touch is
  explicit (2) and leaves `#enteredContext` on `A` untouched, and both remaining `A` touches match
  `#enteredContext` directly (0 each) since nothing ever told decode `A` had stopped being entered. The
  same pattern with an eager leave-on-switch would cost 9; plain explicit-always costs 10.

### Buffers and flush

Three buffers: the event log (fixed-width `Uint32Array` records), the doubles buffer (one `f64` per
float-carrying record, currently only `SET_TAG_NUMBER`, consumed positionally — see "Event kinds" above
for why this isn't a region of the event log), and the string blob (raw UTF-8) — each a plain,
non-resizable `ArrayBuffer`. Flush
triggers when their combined size reaches ~16MB, or on an unref'd ~1-second timer, whichever comes
first. `flush()` is a single synchronous napi call; JS's own byte-offset counters (one per buffer) reset
to 0 immediately after the call returns, so the next write cycle simply starts overwriting from the
front of each. The buffer contents themselves are never zeroed — nothing ever reads past the length it
was told to decode, so there's nothing for a zero-fill to protect against, and it would cost a real
write pass over up to 16MB on every flush for no functional benefit.

## Rust extension

Hand-rolled napi-rs crate, not libdatadog — this is PoC scaffolding, not a shared library integration.

### Buffer handoff

```rust
#[napi]
pub struct EventFlusher {
    events_view: Uint8Array,
    doubles_view: Uint8Array,
    strings_view: Uint8Array,
}

#[napi]
impl EventFlusher {
    #[napi(constructor)]
    pub fn new(events_view: Uint8Array, doubles_view: Uint8Array, strings_view: Uint8Array) -> Self {
        Self { events_view, doubles_view, strings_view }
    }

    #[napi]
    pub fn flush(&mut self, env: Env, events_len: u32, doubles_len: u32, strings_len: u32) -> Result<()> {
        let events = unsafe { self.events_view.as_ref() };
        let doubles = unsafe { self.doubles_view.as_ref() };
        let strings = unsafe { self.strings_view.as_ref() };
        let decoded = decode(
            &events[..events_len as usize],
            &doubles[..doubles_len as usize],
            &strings[..strings_len as usize],
        ); // DD_NATIVE_SPANS_DECODE
        let chunks = process(decoded);                                        // DD_NATIVE_SPANS_PROCESS
        let payload = encode_v05(chunks);                                     // DD_NATIVE_SPANS_ENCODE
        env.spawn(FlushToAgent { payload })?;                                 // DD_NATIVE_SPANS_FLUSH
        Ok(())
    }
}

struct FlushToAgent {
    payload: Vec<u8>,
}

impl Task for FlushToAgent {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        flush_to_agent(&self.payload);
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}
```

Safety invariant: this is only sound because JS is single-threaded and blocked for the whole call —
there is never a concurrent writer, and (see below) decode/process/encode now run to completion before
`flush()` returns, reading the borrowed views directly rather than copying them first. Requires a plain
fixed-size `ArrayBuffer` (a resizable one can move its backing pointer on `.resize()`) and requires the
tracer to never write to any of the three buffers from a Worker thread. `env.spawn` queues `FlushToAgent` on
N-API's own worker pool and returns immediately — `flush()` doesn't wait for the HTTP round trip.

### Decode, process, encode: synchronous by design

An earlier draft ran decode/process/encode on a dedicated background thread (`std::thread::spawn` +
`std::sync::mpsc`), with only the buffer copy happening synchronously in `flush()`. That doesn't hold up
for this PoC's purpose: it would make the reqs/s benchmark measure something easier than what the
*current* implementation already does. Today's `Writer.flush()` already runs `_encoder.makePayload()`
synchronously on the JS thread ([writer.js:33](../../../packages/dd-trace/src/exporters/common/writer.js#L33))
— only the HTTP request itself is non-blocking. Backgrounding decode/process/encode wouldn't just risk
*hiding* their cost from the benchmark; it would compare against an easier bar than the one that ships
today.

So `flush()` does decode → process → encode entirely inline, on the calling thread, blocking for exactly
as long as that takes. That cost is real, visible time in every benchmark that calls it — including the
sirun micro-benchmark below, which an earlier draft excluded it from. Only the HTTP PUT is deferred, via
napi-rs's `Task` trait (`env.spawn`, backed by N-API's own worker pool — no tokio, consistent with the
`ureq` choice below) so the network round trip doesn't block JS, while keeping the same non-blocking
property the current agent writer already has.

Removing the background thread also removes a redundant copy: the earlier draft copied the entire event
log and string blob into an owned `Vec<u8>` so they'd survive the handoff across the channel. Since
decode/process/encode now run to completion during the same call that holds the borrow, they read the
JS-owned buffer views directly — the safety invariant above already guarantees nothing else can touch
them for the call's duration. Only the much smaller *encoded* payload becomes an owned `Vec<u8>`, for the
one thing that genuinely outlives the call: the async HTTP task.

Each `DD_NATIVE_SPANS_*` flag (`DECODE`/`PROCESS`/`ENCODE`/`FLUSH`) is read once at module load and lets
a stage be skipped entirely, for isolating where time goes during development. All four are on by
default; the headline old-vs-new benchmark comparison always runs with all four on.

### Decode

A single sequential pass over the event log: read a record's type tag, look up its `(kind,
entered-state)` word count (decode tracks the same one-bit entered-state `EventWriter` does, purely to
know record widths), extract that record's fields, advance to the next offset. `REGISTER_STRING` records
decode their string into a local, batch-scoped table inline, as they're encountered — the wire protocol
already guarantees a string is registered before its first use, so nothing later in the same pass ever
needs a string that isn't in the table yet. Records whose `(kind, entered-state)` layout entry marks
them as float-carrying (currently only `SET_TAG_NUMBER`) read no value from the word stream at all —
decode keeps its own doubles-buffer cursor, starting at 0, and advances it by that entry's double-count
every time such a record is decoded, same positional-consumption pattern as the string blob. Nothing
about this cursor is `SET_TAG_NUMBER`-specific: a future kind marked as float-carrying in the layout
table participates in the exact same buffer and cursor, no decode changes beyond that one table entry.

No thread pool. An earlier draft of this section proposed splitting into a sequential "index" pass
followed by a `rayon`-parallel "extract" pass, since per-record field extraction has no cross-record
dependency once offsets are known. True, but the wrong thing to reach for here: decode is still called
synchronously from `flush()`, so a thread pool wouldn't hide cost from the benchmark the way the old
background thread did — but it would add real complexity (contention with whatever else is running,
non-deterministic benchmark jitter) to solve a problem nothing has actually measured yet. Single-threaded
decode of a ~16MB batch may simply be fast enough; if benchmarking ever shows otherwise, pulling
extraction out to a thread pool is a small, structurally-easy follow-up — not something to build
speculatively now.

**Fixed per-kind layout, not struct-casting.** Each `(kind, entered-state)` pair already has one fixed
word layout (per "Event kinds" above) — the open question was whether decode should exploit that via
`#[repr(C)]` structs reinterpreted directly from the buffer (`unsafe { &*(ptr as *const T) }`) instead of
reading fields by computed index (`events[offset + 1]`, etc.). For plain `u32`/`f64` fields at
compile-time-constant offsets within a `match` arm, LLVM compiles both down to the same load
instructions — there's no denser packing or SIMD-friendly layout struct-casting recovers that indexed
reads don't already get, so it isn't a real speedup here. Indexed extraction inside the `match` on kind
is simpler to keep in sync with the "Event kinds" table (one place, not a parallel set of `#[repr(C)]`
struct definitions duplicating the same layout by hand), so that's the plan.

### Process (chunk assembly)

Replicates the core of `span_processor.js`'s `process()`: buffer started spans per segment until the
segment's finished count matches its started count (or a `flushMinSpans`-equivalent threshold), then
emit the completed chunk. Explicitly **not** replicated: git metadata tagging, span stats computation,
OTel semantics rewriting, sampling — all out of scope per the PoC's non-goals. Every completed chunk is
exported unconditionally.

### Encode (v0.5)

Hand-rolled msgpack, not `rmp-serde`/`rmpv` — `0.5.js` deliberately mixes fixed and runtime-chosen
widths per field (string-table indices, trace/span/parent ids, and meta/metrics maps are always forced
to a fixed width regardless of value; the outer string-table and trace arrays are always `array32`
regardless of length; `span.start`, `span.duration`, `span.error`, and metric *values* all get the
shortest-int-or-float encoding at runtime via `writeIntOrFloat`). A generic serializer can't reproduce
that exactly. `rmp::encode`'s primitive writers (`write_u32`, `write_u64`, `write_f64`, `write_sint`,
`write_uint`) may be reused as low-level byte writers. Implementation must replicate `0.5.js`'s
`writeIntOrFloat` fast path and its `-0.0`/`NaN`/`Infinity` handling exactly for every field that uses
it, and verify the Rust id type's byte layout/endianness against `Id.toBuffer()`. For `start`/`duration`
specifically, the float branch should never actually fire — see "`id.js` rewrite" for why those are
always integer nanosecond counts by construction — but the dispatch itself must still be replicated
generically, since byte-for-byte fidelity with `0.5.js` is the whole justification for hand-rolling
this encoder rather than reaching for `rmp-serde`.

**Speed relative to `rmp-serde` is not yet verified.** The choice to hand-roll is justified above purely
on fidelity grounds. Structurally, a hand-rolled writer should be at least as fast — it writes directly
to a pre-sized `Vec<u8>` with no `Serialize`-trait dispatch and no generic width-selection logic to route
around, both of which `rmp-serde` pays for and gains nothing from here — but per this repo's own
perf-verification rule (`AGENTS.md`, "Verifying perf-motivated changes"), that reasoning isn't a
substitute for a one-file microbenchmark against `rmp-serde` (with custom `Serialize` impls forcing the
same fixed widths) before the implementation plan treats "at least as fast" as settled.

### Flush to agent

Runs inside `FlushToAgent::compute` (see "Decode, process, encode: synchronous by design" above), on
N-API's worker pool, after `flush()` has already returned to JS. `ureq` 3.x — `reqwest`'s blocking mode
spins up its own internal tokio runtime just to `block_on`, which is exactly the overhead this avoids;
raw `hyper` has no sync client since 1.x. One persistent `ureq::Agent` is built once and reused across
flushes for keep-alive, with explicit connect/read timeouts (`ureq` has no default) — 2 seconds each as
a PoC default, generous for a local agent, not tuned. `PUT /v0.5/traces` with the same headers
`AgentWriter.makeRequest` sends today (`Content-Type: application/msgpack`,
`Datadog-Meta-Tracer-Version`, `X-Datadog-Trace-Count`, `Datadog-Meta-Lang*`).

### Build scaffolding

No `@napi-rs/cli` — that tooling is for cross-compilation, irrelevant to a from-source PoC. Manual
`Cargo.toml` (`crate-type = ["cdylib"]`, `napi`/`napi-derive` dependencies, optional `napi-build` +
`build.rs`). `cargo build --release`, rename the platform-specific output (`.dylib`/`.so`/`.dll`) to
`.node`, load with a plain `require()`.

## Minimal test app + parity harness

### Shared app module

Defined once (e.g. `benchmark/sirun/native-spans/app.js`) and imported by the parity harness, the
sirun end-to-end benchmark, and the standalone debug script — never duplicated:

- `/hello` — automatic `http`/`express` instrumentation only, no manual span calls, replies
  `"hello world"`. Simplest possible case; sanity-checks that the native path doesn't break plain
  root-span capture when handler code never touches `Span` directly.
- `/simple` — one child span, one tag.
- `/busy` — several child spans, multiple tags each — the clustered case the identity-elision
  mechanism is designed for.
- `/error` — throws, exercises the error-tagging path.

### Capture

The existing mock agent (`test/plugins/agent.js`) 404s on `/v0.5/traces`, so the harness stands up its
own small HTTP server accepting `PUT` on both `/v0.4/traces` and `/v0.5/traces`, decodes both (v0.5
needs the string-table + array-of-arrays decode), and normalizes each into a common shape: array of
chunks → array of spans → `{service, name, resource, type, trace_id, span_id, parent_id, start,
duration, error, meta, metrics}`.

### Comparison

The two implementations run as separate process invocations of the same app hitting the same routes, so
ids and timestamps never match across runs — comparison is structural: same chunk count, same span
count/order, same name/resource/service/type/parent-child shape, same tag keys, same tag values except
a documented exclusion list of inherently volatile fields (ids, `start`, `duration`, `runtime-id`,
`_dd.p.tid`, `process_id`). Deterministic ID seeding across both implementations was considered and
rejected — it doesn't buy anything the structural comparison doesn't already answer, for real plumbing
cost.

## Benchmarks

Three artifacts, each answering a different question:

1. **Micro-benchmark** — extends `benchmark/sirun/spans/spans.js` with new variants that set
   `DD_TRACE_EXPERIMENTAL_NATIVE_SPANS=1` alongside the existing `finish-immediately` /
   `finish-immediately-with-tags` / `finish-immediately-with-many-tags` variants, same `SHAPE`/`FINISH`/
   `OPERATIONS` knobs. Answers "is the new `Span` write path faster" — but not in clean isolation:
   `flush()` now runs decode/process/encode inline (see "Decode, process, encode: synchronous by
   design"), so if a run crosses the ~16MB/~1s threshold, that cost is included too, amortized across
   whatever writes preceded it. That's the same trade made for the reqs/s benchmark below, applied
   consistently — no hiding cost off-thread just because this happens to be the micro-benchmark. The
   end-to-end benchmark remains the number that reflects the full realistic pipeline.

2. **End-to-end Express benchmark** — modeled on `benchmark/sirun/plugin-http`: a client/server pair
   over a keep-alive connection, driving the shared test app's routes, with variants for baseline vs.
   `DD_TRACE_EXPERIMENTAL_NATIVE_SPANS=1`. Exports to a lightweight fake-agent sink (the parity harness's
   capture server, minus decoding — just discard the body) instead of a real agent, so numbers aren't
   polluted by network variance or agent availability in CI. This is the one that exercises the full
   pipeline: the JS write path, synchronous decode/process/encode inside `flush()`, and the async HTTP
   PUT. The headline comparison here always runs with all four `DD_NATIVE_SPANS_*` layer flags on.

3. **Standalone debug/load script** (`native-spans-debug.js` at the repo root) — a single new file, not
   built on the pre-existing, unrelated `native-spans-bench.js`, though it reuses that file's
   load-generator math (closed-loop concurrency, histogram-based percentiles) directly rather than
   re-deriving it. Single process, in-process app + fake-agent sink, implementation chosen via
   `DD_TRACE_EXPERIMENTAL_NATIVE_SPANS`.
   - Default mode: print each decoded trace to stdout as it lands, for manual `curl`-and-eyeball
     debugging.
   - `--load [--duration-ms] [--concurrency]`: turn off per-request trace printing, run the load
     generator for the given duration, print `req/s` + p50/p95/p99 to stdout.
   No repetitions, no warmup phase, no JSON report, no third-party workload — that ceremony belongs to
   the sirun benchmarks, not this tool.

## Decisions made while drafting this doc

The prior conversation left a handful of loose ends (naming drift, a couple of methods never
addressed, some unspecified widths). Resolved here with the most consistent choice available; flag any
of these you'd rather change:

- **`setTag(key, true/false)`, `setOperationName`, service/resource/type overrides, `addTags`,
  `addSpanPointer`** were in an earlier method list but dropped from the version actually approved.
  Resolved above by routing them through existing event kinds (reserved tag keys, loops, thin wrappers)
  rather than adding new kinds — consistent with the stated "no new event kind unless needed" pattern
  already used for `addSpanPointer`.
- **`setBaggageItem`** was never addressed at all. Resolved as a silent no-op, same reasoning as the
  getters (no JS-side state to write into, and baggage propagation is already out of scope).
- **Event kind names**: settled on the full forms (`ENTER_CONTEXT_KEEP_LAST`, `ENTER_CONTEXT_NEW`) over
  an earlier shorthand (`ENTER_KEEP_LAST`, etc.) that appeared in the same discussion. An earlier draft
  also had a `LEAVE_CONTEXT` kind; removed once it became clear nothing ever needed to emit it (see
  "Identity elision").
- **Type-tag width**: `Uint32Array`, not `u64` — no event kind needs more than 32 bits of tag space,
  and it keeps the event log uniformly word-aligned for its `Uint32Array` view.
- **`REGISTER_STRING` wire format**: `[stringId, byteLength]` plus positional bytes in the string blob,
  rather than an explicit offset field — simpler, and correct given both sides process strictly in
  registration order.
- **Two vs. three buffers**: an earlier draft put `SET_TAG_NUMBER`'s value inline in the event log,
  read through a `Float64Array` view over the same `ArrayBuffer` as the `Uint32Array` word stream.
  Dropped once it became clear that's not actually constructible: a `Float64Array` view's elements are
  only 8-byte-aligned relative to that view's own fixed origin, and a float-carrying record's offset in
  the word stream (which varies with how many variable-width records preceded it) isn't reliably a
  multiple of 8. Split float values into a shared `Float64Array`-backed doubles buffer, consumed
  positionally during decode exactly like `REGISTER_STRING`'s bytes — see "Event kinds" and "Decode."
  Buffers are now event log, doubles, and string blob, combined into one `flush(eventsLen, doublesLen,
  stringsLen)` napi call. Kept general (any float-carrying kind shares this one buffer, not one buffer
  per kind) rather than `SET_TAG_NUMBER`-specific, since a future kind needing a float64 field shouldn't
  cost a fourth buffer.
- **Float write mechanism**: two alternatives to a dedicated doubles buffer were benchmarked (4M
  writes/trial, 5 trials, reproduced in a fresh process) before settling this: bit-reinterpreting the
  float into two `u32` words via a reused scratch buffer (~1.7x slower, reproducibly) and writing through
  an unaligned-safe `DataView.setFloat64` directly into the word stream (~5-19% slower, reproducibly).
  The dedicated buffer won on both speed and simplicity — no bit-manipulation, no alignment reasoning
  needed on either side of the FFI boundary.
- **Background thread vs. synchronous processing**: an earlier draft ran decode/process/encode on a
  dedicated Rust thread via `std::thread::spawn` + `std::sync::mpsc`. Removed in favor of running them
  inline inside `flush()`, so their cost is real, attributed time in every benchmark rather than hidden
  off-thread — see "Decode, process, encode: synchronous by design." Only the HTTP PUT is still
  deferred, via napi-rs's `Task` trait rather than a hand-rolled channel + worker loop.
- **`ureq` timeout**: 2s connect / 2s read as an unspecified-but-necessary PoC default.
- **napi-rs** itself was adopted throughout without ever being put to an explicit yes/no — stated here
  as the chosen binding approach; no alternative was ever seriously considered against it.
