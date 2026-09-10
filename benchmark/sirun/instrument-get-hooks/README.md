# instrument-get-hooks

Quantifies the cost of the dedupe fix in `getHooks`
(`packages/datadog-instrumentations/src/helpers/instrument.js`). The rewriter
instrumentation list holds one entry per transform, so `getHooks` returned one
hook per transform and integrations registered the same (versionRange,
filePath) several times (144 hooks for the real query set before the fix, 66
after).

The workload models what production actually does: `getHooks` is called once
per module name, **lazily**, from integration files that
`helpers/register.js` only runs when the user's package loads. A traced
process performs **zero** of these calls at tracer init, and all 13 only when
every instrumented package family is used. The 13 queries are the complete set
of call sites in the repo (`ai.js`, `langchain.js`, `mercurius.js`,
`bullmq.js`, `modelcontextprotocol-sdk.js`, `openai-agents.js`,
`langgraph.js`, `aws-durable-execution-sdk-js.js`, `azure-cosmos.js`,
`claude-agent-sdk.js`, and the three in `graphql.js`). There is no hot loop
to optimize and no fixed startup cost to charge against lookup savings, so
the bench measures one simulated lazy load pass per iteration.

- `scan` — the pre-fix implementation, verbatim: map → filter → map, one
  hook per transform (duplicates included).
- `deduped` — the fixed implementation, verbatim: one pass, skipping
  transforms whose (versionRange, filePath) was already emitted, with a Set
  for the requested names.

Variants (`meta.json`):

- `*-cold` — one simulated startup through the measured window per process.
  Each sirun iteration is a fresh process, so the window is paid cold, where
  production pays it. The startup-guard share ceiling is vacuous here by
  design (load+setup legitimately dominates a single pass) — the guard's
  rot protection is carried by the warm variants instead.
- `*-warm` — 20 000 simulated startups per process, for steady-state signal
  over the same workload.

Measured (Node v26.2.0, median of fresh processes / warm loops):

| variant | per startup (13 queries) | hooks resolved |
|---|---|---|
| `scan-cold` | ~175 µs | 144 |
| `deduped-cold` | ~195 µs | 66 |
| `scan-warm` | ~34 µs | 144 |
| `deduped-warm` | ~29 µs | 66 |

Zero-lookup startups (the common case) run no `getHooks` code in either
variant: the fix adds no fixed cost anywhere — nothing is built at require
time.

Read: the correctness fix costs ~10% cold on a process that loads *all* 13
integration families (~20 µs, only paid as the packages load), and wins
~15% warm. A zero-lookup process pays nothing either way.

Run with:

```sh
cd benchmark/sirun/instrument-get-hooks
node ../run-all-variants.js
```
