Long-workload variant of `plugin-graphql`.

Runs many sequential GraphQL queries per process so per-query cost
amortizes past the fixed startup + plugin-setup costs (tracer init,
graphql require, schema parse, any instrumentation-layer one-time work).

## Why this exists

The existing `plugin-graphql` benchmark runs exactly 6 queries per
process (`index.js:46`), then exits. Measured on Node 22.10.0:

| | load CPU (ms) | per-query CPU (ms) | load share @ 6q |
|---|---|---|---|
| master, depth-on-max | ~202 | ~6.6  | ~83% |
| master, collapse-off | ~254 | ~12.9 | ~77% |

At 6 queries, load dominates the measurement — ~80% of the total CPU
budget is spent on one-time setup. Any change that trades startup cost
for steady-state cost (e.g. module rewriting, schema walking,
JIT-warmup-heavy instrumentation) registers as a regression even when
it makes real applications faster.

## Default query count

`QUERIES=100` by default. At that size, load is:

| | load share @ 100q |
|---|---|
| master, depth-on-max | ~23% |
| master, collapse-off | ~16% |

Per-query cost dominates the measurement (~16-23% load share vs
~77-83% at 6 queries), which is the metric that matters for servers
handling many requests per process lifetime.

`QUERIES` is parametric so the same bench can be re-aimed at larger
sizes (e.g. `QUERIES=500` for load <6%) without forking the directory.
The default is tuned to keep the 6-variant × 10-iteration matrix at
~1 min per Node version — comparable to the existing `plugin-graphql`
bench (~45s per Node version) while dropping load share from ~80% to
~20%.

## Relationship to `plugin-graphql`

The existing `plugin-graphql` benchmark (6 queries) is preserved
unchanged — it catches regressions in startup / init / schema-walk
paths. The new `plugin-graphql-long` complements it by catching
regressions in steady-state per-query paths. Both run on every PR via
`benchmark/sirun/runall.sh` automatic subdir discovery.
