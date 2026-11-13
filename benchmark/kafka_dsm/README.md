# Kafka DSM overhead benchmark

Kafka produce/consume workload used to measure how much Data Streams Monitoring
(DSM) adds on top of APM for the Node.js tracer. It follows the canonical
cross-language spec (Linear DSM2-590) shared with dd-trace-py's
`benchmarks/kafka_dsm` and is driven by the `js/data-streams-monitoring` branch
of the `benchmarking-platform` repo. `kafka-dsm.js` has no tracer-specific code:
the tracer is loaded with `node -r dd-trace/init` and DSM is toggled only by
`DD_DATA_STREAMS_ENABLED`.

## Workload

Each iteration, per worker (`NUM_THREADS`, default 1), on a fresh
single-partition topic and consumer group:

- Untimed setup: create the topic, connect producer and consumer, pre-fetch the
  topic metadata (an empty `producer.send()`, kafkajs has no metadata API), and
  join the group via `consumer.run()` while the topic is still empty. The fetch
  loop then runs in the background, but `eachMessage` waits for the consume
  phase, so nothing is consumed or committed while producing.
- Timed produce: 1000 messages (1024-byte payload, no key, headers
  `key0..key4` -> `value0..value4`). kafkajs has no client-side batching, so this
  is 1000 concurrent single-message `send()` calls awaited together (one produce
  span per message, like the other languages).
- Timed consume: all 1000 messages with `autoCommit: false`, awaiting
  `consumer.commitOffsets()` every `COMMIT_EVERY` (default 100) messages and
  after the last one.
- Untimed teardown: consumer and producer disconnect.

Duration per iteration = produce + consume ms; memory = process RSS
(`process.memoryUsage().rss`) after each timed iteration; both reported as
medians. A single worker is the default because extra workers would conflate
instrumentation cost with event-loop contention.

Divergence from .NET: all iterations run in one process with the tracer already
initialized, like Python, so tracer bootstrap and shutdown are excluded.

## Files

- `kafka-dsm.js` -- the workload.
- `run-timeit.js` -- timing harness (`WARMUP` discarded + `COUNT` timed
  iterations), writes `TIMEIT_OUTPUT`.
- `package.json` / `package-lock.json` -- pinned `kafkajs`, the Kafka client
  dd-trace-js instruments (`packages/datadog-plugin-kafkajs`).

## Running locally

Requires a Kafka broker on `localhost:9092`. `dd-trace` is not a dependency;
install the checkout's own dependencies (`yarn install` with Yarn 1.x at the
repository root), then link it (`npm install --no-save ../..`) for the traced
scenarios.

```bash
npm ci

# baseline (no tracer loaded)
KAFKA_TOPIC=bench-baseline TIMEIT_OUTPUT=baseline.json node run-timeit.js

# apm-only
DD_DATA_STREAMS_ENABLED=false KAFKA_TOPIC=bench-apm-only TIMEIT_OUTPUT=apm-only.json \
  node -r dd-trace/init run-timeit.js

# apm+dsm (slug apm-plus-dsm where '+' is unsafe)
DD_DATA_STREAMS_ENABLED=true KAFKA_TOPIC=bench-apm-plus-dsm TIMEIT_OUTPUT=apm-plus-dsm.json \
  node -r dd-trace/init run-timeit.js
```

CI: the `dsm-throughput` job (`.gitlab/benchmarks/dsm-throughput.yml`) runs this on
benchmarking-platform branch `js/data-streams-monitoring` against the pipeline's
checkout (automatic on `master`, manual elsewhere, never blocking).

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `COMMIT_EVERY` | `100` | Sync commit (last consumed offset + 1) every N consumed messages and after the last; integer >= 1. `1` is the per-message commit diagnostic. |
| `NUM_THREADS` | `1` | Produce/consume workers, integer >= 1 (legacy alias `NUM_WORKERS`). Raise only for a contention diagnostic. |
| `KAFKA_TOPIC` | `benchmark-topic` | Base topic name (per-process, per-iteration and per-worker suffixes appended) |
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | Broker address |
| `WARMUP` | `5` | Discarded warmup iterations, integer >= 0 |
| `COUNT` | `25` | Timed iterations, integer >= 1 |
| `TIMEIT_OUTPUT` | `results.json` | Output artifact path |
| `EXPERIMENT_NAME` | `kafka_dsm` | `name` of the result object |
| `DD_DATA_STREAMS_ENABLED` | -- | The only differentiator between apm-only (`false`) and apm+dsm (`true`) |

## Output

```
[{"median": <duration ms>,
  "metrics": {
    "process.internal_duration_ms.median": <ms>, "process.internal_duration_ms.std_err": <ms>,
    "process.rss_bytes.median": <bytes>, "process.iteration_wall_ms.median": <ms>,
    "phase.produce_ms.median": <ms>, "phase.consume_ms.median": <ms>,
    "config.commit_every": <COMMIT_EVERY>, "config.num_threads": <NUM_THREADS>},
  "name": <EXPERIMENT_NAME>, "warmUpCount": <WARMUP>, "count": <COUNT>,
  "data": [{"status": "Passed", "metrics": {
    "process.internal_duration_ms": <ms>, "process.corrected_duration_ms": <ms, iteration wall>,
    "runtime.dotnet.mem.committed": <bytes, process RSS>}}, ...one per timed iteration]}]
```

`process.iteration_wall_ms` includes setup and teardown and is context only.
`data` feeds bp-analyzer's TimeItSharp converter (`steps/convert-to-common-format.sh`),
which reads per-iteration values under TimeItSharp's metric names (it maps
`runtime.dotnet.mem.committed` to RSS whatever the runtime) and fails without it.
