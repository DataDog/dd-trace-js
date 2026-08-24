This benchmark compares the MariaDB query hot path across the legacy plugin and shared database processor/adapter
implementations. Sirun runs the definition against baseline and candidate source revisions, so the MariaDB plugin and
its shared lifecycle dependencies resolve to the implementation belonging to each revision.

The timed loop drives the existing `apm:mariadb:query:start` and `finish` channels. This is the boundary shared by the
v2 callback/promise wrappers and v3 command wrapper, and it avoids measuring a database server. Span export is
stubbed, but accepted calls allocate a real `DatadogSpanContext` and exercise resource/tag construction, legacy-store
binding, and database finalization.

Variants cover the query paths required by the migration:

- `direct`: direct connection query facts;
- `pool`: pool query facts, including `mariadb.pool.wait_time`;
- `disabled`: the tracing-disabled source path.

The fixture ring keeps source shapes stable and prevents per-iteration fixture construction from dominating the
result. Preflight and post-loop assertions pin span/context cardinality. Each process warms the selected path for at
least one second before resetting counters and starting the timed loop.

For a quick local sample without the sirun controller:

```sh
LOCAL_BENCHMARK_REPORT=true \
STARTUP_GUARD_REPORT=/tmp/ddtrace-mariadb-pipeline-startup \
VARIANT=direct OPERATIONS=1000000 node index.js
```

Five fresh-process trials per implementation were interleaved on 2026-08-21 with Node.js 25 on Apple Silicon. Each
accepted-path trial ran 1,000,000 timed operations after the one-second warmup; the disabled path ran 5,000,000:

| Path | Legacy plugin ns/op | Processor/adapter ns/op | Delta |
| --- | ---: | ---: | ---: |
| direct query | 837.3 | 931.4 | +94.1 ns / +11.2% |
| pool query facts | 847.7 | 998.8 | +151.1 ns / +17.8% |
| tracing disabled | 2.59 | 1.33 | -1.26 ns / -48.6% |

The legacy implementation was loaded from commit `286fc250d`; the processor/adapter numbers used the working tree.
The accepted-path increases are reproducible isolated costs. The larger pool delta includes normalization and tagging
of `mariadb.pool.wait_time`, not pool acquisition itself. Keep these absolute deltas as the regression signal: a real
MariaDB query is network-bound, but this integration is hot enough that further framework growth still needs explicit
measurement.
