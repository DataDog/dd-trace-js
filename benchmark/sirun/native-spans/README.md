# native-spans

End-to-end benchmark, parity harness and shared test app for the native-spans PoC —
a `Span` implementation whose every mutating method is a fixed-width write into a
shared buffer, with decode, chunk assembly, msgpack encoding and HTTP export handled by
a Rust native extension.

Selected with `DD_TRACE_EXPERIMENTAL_NATIVE_SPANS=1`. Not shipped, not backported.

## Build the extension first

```bash
npm run build:native-spans
```

Without it the JS write path still runs and the batches are dropped, with one
`log.error` on startup — useful for isolating the write path, useless for anything
that asserts on exported spans.

## Files

| File | Purpose |
|---|---|
| `app.js` | The shared test app: `/hello` (auto-instrumentation only), `/simple` (one child span, one tag), `/busy` (five child spans, four tags each — the clustered shape identity elision targets), `/error` (throws). Imported by all three consumers, never duplicated. |
| `capture-server.js` | Trace sink accepting `PUT /v0.4/traces` and decoding each span into one comparable shape. `decode: false` turns it into a discard-the-body sink. |
| `parity.js` | Runs the app twice — baseline, then native — and compares what each exported. |
| `parity-worker.js` | One side of that comparison, as a child process. |
| `server.js` / `client.js` / `common.js` / `meta.json` | The sirun end-to-end benchmark: an untraced client driving the traced server over one keep-alive connection. |

## Wire format

The extension always `PUT`s `/v0.4/traces`, whatever `DD_TRACE_AGENT_PROTOCOL_VERSION`
says, and its bytes are pinned against `0.4.js` by
`v04_matches_the_js_encoder_byte_for_byte` in `native/src/tests.rs`.

Two things the JS encoders do that this one deliberately does not, both measured rather
than assumed — worth knowing before adding either back:

- **No indexed string table.** The agent's other trace format hoists every string into a
  leading table and refers to it by index. Implemented here, it encoded at half the speed
  (35 ms against 17 ms per 150k spans): a table trades a `memcpy` for a hash lookup per
  string, and a Rust `Rc<str>` is already UTF-8, so there is no conversion left for the
  table to amortise. The same trade favours the table in JS, where it avoids repeated
  UTF-16 to UTF-8 conversions — which is why the JS encoder has one and this does not.
- **No string cache**, unlike `0.4.js`, for the same reason: caching pre-encoded bytes
  buys nothing when the bytes are already sitting there. Measured at 49% slower — 29.0 ms
  against 19.5 ms for the same 13.5 MB of output.

## Parity

```bash
node benchmark/sirun/native-spans/parity.js
```

Both sides are pinned to the same wire format, so a format difference can never read as a
real one.

The two implementations run as separate process invocations, so ids and timestamps
never match; the comparison is structural — same chunk count, same span count and
order, same name / resource / service / type, same parent-child shape, same tag keys
and values.

Two exclusion lists, both deliberate:

- `EXCLUDED_TAGS` — values that cannot match across two processes (ids, `runtime-id`,
  `process_id`) or that a stated non-goal means the native path never produces at all
  (everything sampling-related, git metadata, process tags).
- `EXPECTED_DIFFERENCES` — differences that follow from a non-goal, each with its
  mechanism named. They are reported and not counted as failures, so `PARITY OK` means
  "no *unexplained* divergence". Currently: the framework span's resource missing its
  route (`addResourceTag` re-reads a tag that no longer exists to read), and a
  `terminated_context` span link (no trace-level tag map, so `_dd.p.tid` cannot ride
  the Datadog headers while `traceparent` carries the full 128-bit id).

## Benchmarks

```bash
# End-to-end, both variants
cd benchmark/sirun/native-spans && sirun meta.json

# Write-path micro-benchmark (variants suffixed `-native`)
cd benchmark/sirun/spans && sirun meta.json
```

Everything up to and including encode runs synchronously inside `flush()`, so its cost
is real, attributed time in both benchmarks. Only the HTTP PUT is deferred, which is
what the baseline's `Writer.flush()` already does.

Five stage flags isolate where time goes during development, all on by default. Each
is an outer rung of the same ladder, so subtracting adjacent rows attributes a stage.
The headline comparison always runs with all five on.

| flag | what still runs |
|---|---|
| `DD_NATIVE_SPANS_WRITE=0` | the span layer only — ids, timestamp splitting, tag dispatch, link and event serialization; no buffer writes, no interning, nothing for Rust to read |
| `DD_NATIVE_SPANS_DECODE=0` | + buffer writes and interning |
| `DD_NATIVE_SPANS_PROCESS=0` | + decode |
| `DD_NATIVE_SPANS_ENCODE=0` | + chunk assembly, without writing any bytes |
| `DD_NATIVE_SPANS_FLUSH=0` | + encoding, no HTTP PUT |

Assembly and encoding are one pass — a finished span is written to bytes while the
assembler still holds it — so `ENCODE=0` skips the byte writing inside that pass rather
than skipping a separate stage.

`WRITE=0` is the JS-side rung and is read straight from the environment, like the four
Rust ones; none of them is registered in `supported-configurations.json`, because they
are development instrumentation rather than product configuration.

Two caveats when using them with `benchmark/sirun/spans`:

- `WRITE=0` makes the loop fast enough to trip that benchmark's startup-share guard at
  `OPERATIONS=2000000`. Raise it (6M works) so startup stays under the ceiling.
- The baseline column there stubs `_processor.process` out entirely, so it excludes
  `span_format` and msgpack. For a full-pipeline comparison, replace that override with
  `tracer._tracer._processor._exporter._writer._sendPayload = function () {}` — which
  keeps formatting and encoding and drops only the socket write.

## Rust stage timings

```bash
cd packages/dd-trace/src/native-spans/native
cargo test --release -- --nocapture --ignored --test-threads=1
BENCH_SPANS_PER_SEGMENT=8 cargo test --release stage_timings -- --nocapture --ignored --test-threads=1
```

`--test-threads=1` matters: the harnesses contaminate each other's timings otherwise.

`BENCH_SPANS_PER_SEGMENT` defaults to 1, which is the worst case for per-segment overhead
and unlike anything real — an Express request produces three to eight spans in one
segment. It is worth setting before optimising anything: going from 1 to 8 halves assembly
(41 ms to 21 ms per 150k spans), because half of what the default measures is per-segment
bookkeeping that real traces amortise away.

## Debugging

```bash
DD_TRACE_EXPERIMENTAL_NATIVE_SPANS=1 node native-spans-debug.js
DD_TRACE_EXPERIMENTAL_NATIVE_SPANS=1 node native-spans-debug.js --load --duration-ms 10000
```

Single process, app plus sink plus load generator. Default mode prints each decoded
trace as it lands; `--load` prints req/s and p50/p95/p99.
