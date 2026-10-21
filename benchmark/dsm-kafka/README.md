# DSM Kafka overhead benchmark

Measures how much APM and Data Streams Monitoring (DSM) slow down a kafkajs produce+consume loop.
Client: `kafkajs@2.2.4` (installed in this folder only). `packages/datadog-plugin-kafkajs` creates DSM
checkpoints on produce (`direction:out`) and consume (`direction:in`, also for `eachBatch`).
The tracer is always the one in the worktree that contains this folder (`node --require <worktree>/init.js`).

## Build

```sh
yarn install --frozen-lockfile   # at the worktree root: installs deps and builds vendor/ (the "prepare" script)
```

The benchmark's own dependency (`kafkajs`) is installed by `run.sh` on first use (`npm ci` here).
Re-run the yarn command in any new worktree. There is no other build step: the tracer runs from source.

## Run

Needs Kafka on `localhost:9092` and a mock agent on `127.0.0.1:18127` (see the on-by-default `PHASE1.md`).

```sh
benchmark/dsm-kafka/run.sh <baseline|apm-only|apm+dsm> [optimization-slug]
PROFILE=1 benchmark/dsm-kafka/run.sh apm+dsm my-slug     # profile pass (timings are inflated)
```

Scenarios: `baseline` (no tracer), `apm-only` (`DD_DATA_STREAMS_ENABLED=false`), `apm+dsm` (`DD_DATA_STREAMS_ENABLED=true`).

Each iteration: create a fresh single-partition topic and join the consumer group (untimed), **produce** 1000
messages with 5 headers, **consume** them with a sync offset commit every `COMMIT_EVERY` and after the last
(both timed), then disconnect (untimed). `WARMUP` iterations are discarded, `COUNT` are recorded.

| Env | Default | |
|---|---|---|
| `COMMIT_EVERY` | 100 | Sync commit every N messages |
| `NUM_THREADS` | 1 | Only 1 is supported |
| `WARMUP` / `COUNT` | 5 / 25 | Discarded / timed iterations |
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | |
| `KAFKA_TOPIC` | `benchmark-topic-node-<scenario>-<slug>` (`+`→`plus`) | Base name; `-<run id>-<iteration>` is appended |
| `TIMEIT_OUTPUT` | `results.node.<scenario>.json` in this folder | `{runs: [{produce_ms, consume_ms}], max_rss_mb, commit_every, profiled}` |
| `PROFILE` | 0 | `1` enables the profiler |
| `PROFILE_OUTPUT` | `profile.node.<scenario>.cpuprofile` in this folder | Hot list goes to `<same name>.top.txt` |
| `DD_TRACE_AGENT_URL` | `http://127.0.0.1:18127` | Never use 8126 |

`<scenario>` in file names is `baseline`, `apm-only` or `apmplusdsm`. Outputs are git-ignored.

## Profiling

`PROFILE=1` starts a V8 CPU profile (in-process `node:inspector`, 200 µs sampling) right before the produce phase
and stops it right after the consume phase of every *timed* iteration, so setup, teardown and warmup are not sampled.
The per-iteration profiles are merged into one `.cpuprofile` (open in Chrome DevTools / VS Code) and summarised in
`.top.txt` (top self and inclusive time, idle/GC excluded). Samples taken inside the profiler's own `session.post()`
calls are dropped.

## Notes

- The process exits naturally (not `process.exit`) so the tracer's `beforeExit` hooks flush traces and DSM stats.
  DSM stats are flushed every 10 s, so a very short run (e.g. `WARMUP=1 COUNT=3`) only reports `/v0.1/pipeline_stats`
  at exit; check the mock agent `GET /counts` after the process ended.
- Node prints a `TimeoutNegativeWarning` from kafkajs under Node 24 in every scenario, including baseline; it is harmless.
