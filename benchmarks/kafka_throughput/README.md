# Kafka throughput benchmark (DSM overhead)

Standalone Kafka produce/consume workload used to measure Data Streams
Monitoring (DSM) overhead on top of APM for the Node.js tracer. It is the
Node.js counterpart of the Python `benchmarks/kafka_throughput` workload
(itself a port of the .NET `Samples.KafkaBenchmark`) and is driven by the
`js/data-streams-monitoring` branch of the `benchmarking-platform` repo.

## Files

- `kafka_throughput.js` -- the workload, per the canonical cross-language
  spec (Linear DSM2-590): `NUM_THREADS` (default 1) parallel workers, each
  with a fresh single-partition topic and consumer group per iteration.
  Each produces 1000 messages (fixed 1024-byte payload, no key, headers
  `key0..key4` -> `value0..value4`), then consumes all 1000 back with a
  synchronous offset commit every `COMMIT_EVERY` (default 100) messages and
  after the last one. Only produce and consume are timed; topic creation,
  client connect, producer metadata pre-fetch, group join and client close
  are not. kafkajs has no client-side batching, so produce is 1000 concurrent
  single-message `send()` calls awaited together (per-message produce +
  flush, one produce span per message). No tracer-specific code -- DSM is
  toggled purely via `DD_DATA_STREAMS_ENABLED`.
- `run_timeit.js` -- timing harness (5 warmup + 25 timed iterations by
  default), emits a JSON artifact compatible with `steps/compare-results.py`.
  Reports median produce+consume duration (ms), median per-iteration process
  RSS (bytes) and median per-phase durations.
- `package.json` -- depends on `kafkajs`, the Kafka client dd-trace-js
  instruments (`packages/datadog-plugin-kafkajs`).

## Running locally

Requires a Kafka broker on `localhost:9092`. `dd-trace` is not a dependency;
install it (e.g. `npm install --no-save ../..` from a source checkout) for the traced
scenarios.

```bash
npm install

# baseline (no tracer loaded)
KAFKA_TOPIC=bench-baseline TIMEIT_OUTPUT=baseline.json node run_timeit.js

# apm-only
DD_DATA_STREAMS_ENABLED=false KAFKA_TOPIC=bench-apm-only TIMEIT_OUTPUT=apm-only.json \
  node -r dd-trace/init run_timeit.js

# apm+dsm (slug apm-plus-dsm where '+' is unsafe)
DD_DATA_STREAMS_ENABLED=true KAFKA_TOPIC=bench-apm-plus-dsm TIMEIT_OUTPUT=apm-plus-dsm.json \
  node -r dd-trace/init run_timeit.js
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `COMMIT_EVERY` | `100` | Consume-phase commit mode: synchronously commit (last consumed offset + 1) after every N consumed messages and always after the last (10 commits per run at 100). `1` is the per-message sync commit, an on-demand diagnostic. Must be an integer >= 1. Recorded as `config.commit_every` in the results JSON and as `commit every N` in the summary line. |
| `NUM_THREADS` | `1` | Produce/consume workers (integer >= 1; legacy alias `NUM_WORKERS`). Single-worker by default so the measurement reflects instrumentation cost rather than event-loop/IPC contention; raise only for a deliberate contention diagnostic. Recorded as `config.num_threads`. |
| `KAFKA_TOPIC` | `benchmark-topic` | Base topic name (per-process, per-iteration and per-worker suffixes appended) |
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | Broker address |
| `WARMUP` | `5` | Discarded warmup iterations |
| `COUNT` | `25` | Timed iterations feeding the median |
| `TIMEIT_OUTPUT` | `results.json` | Output artifact path |
| `DD_DATA_STREAMS_ENABLED` | -- | The only differentiator between apm-only (`false`) and apm+dsm (`true`) |
