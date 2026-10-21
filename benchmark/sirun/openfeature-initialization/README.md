# OpenFeature provider initialization

Measures a fresh tracer provider from construction through initialization promise
settlement and cleanup. Unlike the evaluation benchmark in `../openfeature`,
initialization is inside the measured loop. All variants use the real vendored
provider, initialization controller, timers and logger. Debug logging is disabled;
the failure path still calls the real `errorWithoutTelemetry` logger.

Configuration transport is replaced with direct delivery to exclude network wait.
Evaluation metrics, span enrichment and evaluation-event delivery are disabled.
Each operation checks its configuration or rejection and closes the provider.
These checks and the benchmark's await overhead are included equally on both sides.
This measures provider startup work, not application cold-start time or remote
configuration latency. Error construction and module loading are outside timing.

Variants:

- `preloaded`: configuration is available before `initialize()`.
- `configuration`: configuration arrives after `initialize()` starts; includes
  timer creation/cancellation and all initialization promise settlement.
- `error`: `setError()` rejects initialization; includes rejection handling and
  timer cancellation, but does not wait for the timeout duration.

Sirun automatically discovers this directory and runs all three variants in CI,
with 11 repetitions and 1,000,000 operations per repetition. Each process warms
up with 10,000 separate provider initializations before the measured loop.

From this directory, using the repository-pinned Sirun version:

```sh
DD_TRACE_DEBUG=false ENABLE_AFFINITY=1 CPU_AFFINITY=2 node ../run-all-variants.js
```

To compare another checkout with the same benchmark, set `DD_BENCH_SOURCE_ROOT`
to its absolute path. Install/build that checkout's dependencies first. For an
isolated tracer comparison, use the same dependency versions and vendored provider
bundle in both checkouts and record that constraint with the results.

```sh
DD_BENCH_SOURCE_ROOT=/absolute/path/to/baseline DD_TRACE_DEBUG=false \
  ENABLE_AFFINITY=1 CPU_AFFINITY=2 node ../run-all-variants.js
```

Choose an available CPU on your machine. Alternate baseline/candidate order across
repetitions to reduce ordering effects. The benchmark emits `nsPerInitialization`
as JSON to stdout for standalone runs and stderr under Sirun; Sirun also records
`openfeature-initialization.ops`. Standalone smoke checks:

```sh
SCENARIO=preloaded OPERATIONS=1000 WARMUP=100 node index.js
SCENARIO=configuration OPERATIONS=1000 WARMUP=100 node index.js
SCENARIO=error OPERATIONS=1000 WARMUP=100 node index.js
```

If hardware counters are unavailable locally, generate `meta-temp.json` with
`node ../squash-affinity.js`, set its `instructions` field to `false`, then run
`SIRUN_VARIANT=<variant> sirun meta-temp.json` for each variant. Leave the committed
`meta.json` unchanged so CI retains instruction counting.
