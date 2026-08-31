Override for `reviewers/performance.md` (in the core skill folder) — read that file first, then this.

# Performance — dd-trace-js specifics

## Hot paths in dd-trace-js

Per-span / per-request:
- `packages/dd-trace/src/opentracing/tracer.js` — `startSpan()` (line ~69) and `packages/dd-trace/src/opentracing/span.js` (span constructor, `setTag`, `finish`, handle stashing into storage).
- `packages/datadog-core/src/storage.js` — `DatadogStorage.getStore()/getHandle()/enterWith()`; every plugin `bindStart`/`runStores` goes through this AsyncLocalStorage. ALS/`async_hooks` cost is paid per async hop; under AsyncContextFrame the store is held directly, pre-ACF it goes through a WeakMap handle. Never add a new `AsyncResource`/hook per operation.
- `packages/dd-trace/src/plugins/plugin.js` — `addSub()`/handler dispatch, and the base classes `plugins/tracing.js`, `client.js`, `server.js`, `database.js`, `consumer.js`, `producer.js` (`bindStart`, `bindFinish`, `start`, `error`, `finish`).
- `packages/datadog-instrumentations/src/helpers/instrument.js` + the wrappers in each `packages/datadog-instrumentations/src/<lib>.js` — the wrapper function body runs on every library call; `channel.publish` must be gated on `channel.hasSubscribers`.
- `packages/datadog-shimmer/src/shimmer.js` (package entry `packages/datadog-shimmer/index.js`) — wrap/unwrap machinery in the call path.
- `packages/dd-trace/src/priority_sampler.js`, `sampling_rule.js`, `rate_limiter.js`, `span_processor.js`, `span_sampler.js`, `span_format.js`, `id.js` (ID generation per span), `tagger.js`.
- Encode/flush: `packages/dd-trace/src/encode/0.4.js`, `packages/dd-trace/src/encode/0.5.js`, `packages/dd-trace/src/msgpack/` (note: msgpack is a sibling of `encode/`, not inside it), `packages/dd-trace/src/exporters/agent/*`.
- AppSec per-request: `packages/dd-trace/src/appsec/index.js`, `waf/`, `store.js`, `reporter.js`, `rasp/`; IAST rewriting in `packages/datadog-instrumentations/src/helpers/rewriter`.

Startup / require-time:
- `packages/dd-trace/src/index.js`, `proxy.js`, `bootstrap.js`, `packages/dd-trace/src/guardrails/index.js` (runs before anything, must stay dependency-free), `ritm.js`/`iitm.js` (require hooks — run for every `require()` in the app), `packages/datadog-instrumentations/src/helpers/hooks.js` (lazy hook table; adding eager `require`s here inflates startup), `packages/dd-trace/src/config/index.js`, `startup-log.js`.

Anything added to these files pays cost on every span/request/require — measure it. First determine whether the change touches one: a slow function on a once-per-process path is a non-issue; the same function on span start is a top-severity finding.

## Language-specific cost model for dd-trace-js

Read **AGENTS.md § "Production Safety and Performance"** first: it states the principle ("CRITICAL: Tracer runs in application hot paths - every operation counts") and owns the explicit prohibitions (no `async`/`await` or promises in npm-shipped code outside tests and worker threads; loop-form rules and the `for-in` ban; no `Object.keys(obj).length` emptiness probe; cache regexes and parsed values at module load; order short-circuit chains by frequency x cheapness; avoid try/catch and accessors in hot paths). Apply that section as written; do not paraphrase it into a weaker rule.

The following are NOT in that section - they are derived from repo code, with the source named, and are the ones most often missed:
- Allocation is the dominant per-span cost: objects, closures, strings, boxes, intermediate arrays from `.map`/`.filter`, and allocations hidden in convenience APIs.
- Keep call sites monomorphic and hidden classes stable - initialize all fields in one order, do not add properties later (evidence: comments in `packages/dd-trace/src/span_format.js`, `src/encode/0.4.js`, `src/encode/0.5.js`).
- `async_hooks`/AsyncLocalStorage propagation is the largest structural overhead; a new ALS instance, an extra `enterWith`, or an `AsyncResource` per operation multiplies it (evidence: `packages/datadog-core/src/storage.js`).
- Require-time cost is user-visible startup latency; keep new `require`s lazy (evidence: the lazy thunk table in `packages/datadog-instrumentations/src/helpers/hooks.js`).
- Verification bar for a perf-motivated change is in AGENTS.md § "Production Safety and Performance" (the microbenchmark requirement bullet); a rewrite justified by speed with no numbers is a finding.

## Additional checks specific to this repo

- **Regex use** on hot paths: is it precompiled, anchored, and free of catastrophic backtracking?
- **Data-volume growth.** More tags/metrics/spans per request increases payload size, serialization cost, and customer bill. Adding a high-cardinality tag is at least P1.

## Evidence

Benchmarks for this repo:
- Macro/one-off: `npm run bench` (`node benchmark/index.js`); also `benchmark/{core,dd-trace,scope,openfeature,iast-evidence-redaction}.js`, `benchmark/stubs/`, and `npm run bench:e2e:test-optimization` (`benchmark/e2e-test-optimization/benchmark-run.js`).
- Tracked CI benchmarks: `benchmark/sirun/` (per-area dirs: `plugin-http`, `plugin-kafkajs`, `encoding`, `async_hooks`, `appsec`, `appsec-iast`, `llmobs`, `startup`, `log`, `fs`, `event_loop.js`, `gc.js`, …). Per `benchmark/sirun/README.md`:
```bash
cargo install --git https://github.com/DataDog/sirun.git --branch main
cd benchmark/sirun/<dir>
node ../run-all-variants.js | sirun --summarize | node ../means.js
```
- Ad-hoc perf verification per AGENTS.md § "Production Safety and Performance" (the microbenchmark requirement bullet): a one-file microbenchmark, ~1 s warmup, ≥5 trials each impl, re-run in a fresh shell; delete it afterwards or graduate it to `benchmark/sirun/`. A perf-justified rewrite in the diff without numbers is a finding.
