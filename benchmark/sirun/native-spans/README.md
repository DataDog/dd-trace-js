# native-spans

End-to-end benchmark, parity harness and shared test app for the native-spans PoC —
a `Span` implementation whose every mutating method is a fixed-width write into a
shared buffer, with decode, chunk assembly, v0.5 encoding and HTTP export handled by
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
| `capture-server.js` | Trace sink accepting `PUT` on `/v0.4/traces` and `/v0.5/traces`, decoding both into one comparable shape. The repo's mock agent 404s on v0.5. `decode: false` turns it into a discard-the-body sink. |
| `parity.js` | Runs the app twice — baseline, then native — and compares what each exported. |
| `parity-worker.js` | One side of that comparison, as a child process. |
| `server.js` / `client.js` / `common.js` / `meta.json` | The sirun end-to-end benchmark: an untraced client driving the traced server over one keep-alive connection. |

## Wire protocols

The native encoder implements both agent trace formats and follows
`DD_TRACE_AGENT_PROTOCOL_VERSION`, so it speaks whichever one the rest of the tracer was
configured for. v0.4 is the tracer's default. Both are pinned byte for byte against the
JS encoders by `v04_matches_the_js_encoder_byte_for_byte` and its v0.5 counterpart in
`native/src/tests.rs`.

Measured, 150k spans, medians of five (`cargo test --release stage_timings`):

| | encode | payload |
|---|---|---|
| v0.4 | 17.0 ms | 42.8 MiB |
| v0.5 | 35.2 ms | 20.5 MiB |

**v0.4 encodes twice as fast in Rust, and that is the reverse of JS**, where v0.5 is
~22% faster (2030 ms vs 2600 ms over 2M spans). The two languages are paying for
different things: JS spends its time converting UTF-16 strings to UTF-8, which v0.5's
string table amortises across every repeat, while a Rust `Rc<str>` is already UTF-8 so
emitting a string is a length prefix plus a `memcpy` — and v0.5's per-string hash lookup
costs more than the bytes it saves.

For the same reason there is **no string cache in the Rust v0.4 encoder**, unlike
`0.4.js`. Caching pre-encoded bytes trades that `memcpy` for a hash lookup and nothing
else; `v04_string_cache_comparison` prices it at **49% slower** (29.0 ms against 19.5 ms
for the same 13.5 MB of output). The JS cache is not a mistake — it avoids a conversion
that simply does not exist on the Rust side.

## Parity

```bash
node benchmark/sirun/native-spans/parity.js          # both protocols
PARITY_PROTOCOL=0.4 node benchmark/sirun/native-spans/parity.js
```

Each pass compares native against a baseline speaking the *same* protocol, so a format
difference can never be mistaken for a real one.

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
| `DD_NATIVE_SPANS_ENCODE=0` | + chunk assembly |
| `DD_NATIVE_SPANS_FLUSH=0` | + v0.5 encoding, no HTTP PUT |

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

## Debugging

```bash
DD_TRACE_EXPERIMENTAL_NATIVE_SPANS=1 node native-spans-debug.js
DD_TRACE_EXPERIMENTAL_NATIVE_SPANS=1 node native-spans-debug.js --load --duration-ms 10000
```

Single process, app plus sink plus load generator. Default mode prints each decoded
trace as it lands; `--load` prints req/s and p50/p95/p99.
