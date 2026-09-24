# Kafka throughput benchmark (DSM overhead)

Standalone Kafka produce/consume workload used to measure Data Streams
Monitoring (DSM) overhead on top of APM for the Node.js tracer. It is the
Node.js counterpart of the Python `benchmarks/kafka_throughput` workload
(itself a port of the .NET `Samples.KafkaBenchmark`) and is driven by the
`js/data-streams-monitoring` branch of the `benchmarking-platform` repo.

## Files

- `kafka_throughput.js` -- the workload: `NUM_WORKERS` (default 1) parallel
  workers, each producing 1000 messages (5 headers each) to its own topic,
  then synchronously consuming and committing all 1000 back. No
  tracer-specific code -- DSM is toggled purely via environment.
- `run_timeit.js` -- timing harness (5 warmup + 25 timed iterations by
  default), emits a JSON artifact compatible with `steps/compare-results.py`.
  Reports median duration (ms) and median process RSS (bytes).
- `package.json` -- depends on `kafkajs`, the Kafka client dd-trace-js
  instruments (`packages/datadog-plugin-kafkajs`).

## Running locally

Requires a Kafka broker on `localhost:9092`.

```bash
npm install

# DSM disabled (APM-only baseline)
DD_TRACE_ENABLED=true DD_DATA_STREAMS_ENABLED=false \
  KAFKA_TOPIC=test-topic-no-dsm TIMEIT_OUTPUT=tracer-no-dsm.json \
  node -r dd-trace/init run_timeit.js

# DSM enabled
DD_TRACE_ENABLED=true DD_DATA_STREAMS_ENABLED=true \
  KAFKA_TOPIC=test-topic-dsm TIMEIT_OUTPUT=dsm-enabled.json \
  node -r dd-trace/init run_timeit.js
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `NUM_WORKERS` | `1` | Produce/consume workers. Single-worker by default so the measurement reflects instrumentation cost rather than event-loop/IPC contention; raise only for a deliberate contention diagnostic. |
| `KAFKA_TOPIC` | `benchmark-topic` | Base topic name (per-run/per-worker suffixes appended) |
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | Broker address |
| `WARMUP` | `5` | Discarded warmup iterations |
| `COUNT` | `25` | Timed iterations feeding the median |
| `TIMEIT_OUTPUT` | `results.json` | Output artifact path |
| `DD_DATA_STREAMS_ENABLED` | -- | The only differentiator between the two experiments |
