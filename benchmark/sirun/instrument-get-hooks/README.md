# instrument-get-hooks

Quantifies the cost of the dedupe fix in `getHooks`
(`packages/datadog-instrumentations/src/helpers/instrument.js`). The rewriter
instrumentation list holds one entry per transform, so `getHooks` returned one
hook per transform and integrations registered the same (versionRange,
filePath) several times (144 hooks for the real query set before the fix, 66
after).

The workload models what production actually does, end to end:

- `getHooks` is called once per module name, **lazily**, from integration
  files that `helpers/register.js` only runs when the user's package loads.
  A traced process performs **zero** of these calls at tracer init, and all
  13 only when every instrumented package family is used. The 13 queries
  are the complete set of call sites in the repo (`ai.js`, `langchain.js`,
  `mercurius.js`, `bullmq.js`, `modelcontextprotocol-sdk.js`,
  `openai-agents.js`, `langgraph.js`, `aws-durable-execution-sdk-js.js`,
  `azure-cosmos.js`, `claude-agent-sdk.js`, and the three in `graphql.js`).
- Production call sites never stop at the hook count: each one registers
  every returned hook through `addHook` (for example `azure-cosmos.js`:
  `for (const hook of getHooks('@azure/cosmos')) addHook(hook, exports =>
  exports)`). The bench models that pass too — one closure, one push into
  the per-name list, per returned hook — because the number of returned
  hooks (144 vs 66) is a real part of what the fix changes.

There is no hot loop to optimize and no fixed startup cost to charge against
lookup savings, so the bench measures one simulated lazy load pass per
iteration.

- `scan` — the pre-fix implementation, verbatim: map → filter → map, one
  hook per transform (duplicates included).
- `deduped` — the fixed implementation, verbatim: one pass, skipping
  transforms whose (versionRange, filePath) was already emitted, with a Set
  for the requested names.

Both live in `get-hooks.js`; `validate.js` runs as a sirun `setup` command
before the measured process exists, so its equivalence gate can neither warm
the measured process nor land inside the measured window.

Variants (`meta.json`):

- `*-cold` — one simulated startup through the measured window per process.
  Each sirun iteration is a fresh process, so the window is paid cold, where
  production pays it. The startup-guard share ceiling is vacuous here by
  design (load+setup legitimately dominates a single pass) — the guard's
  rot protection is carried by the warm variants instead. Cold variants
  deliberately set no `OPERATIONS`: the ops-gauge emission runs after the
  loop but before process exit — inside sirun's measured window — and
  requires the tracer's statsd client plus a UDP socket, a fixed cost that
  would dwarf a single ~0.4 ms sample. Cold samples are read from sirun's
  `wall.time`/`instructions`, which stay clean.
- `*-warm` — 20 000 simulated startups per process, for steady-state signal
  over the same workload.

Measured (Node v26.5.0, median of fresh processes / warm loops):

| variant | per startup (13 queries + registration) | hooks registered |
|---|---|---|
| `scan-cold` | ~435 µs | 144 |
| `deduped-cold` | ~470 µs | 66 |
| `scan-warm` | ~22.5 µs | 144 |
| `deduped-warm` | ~27 µs | 66 |

Zero-lookup startups (the common case) run no `getHooks` code in either
variant: the fix adds no fixed cost anywhere — nothing is built at require
time.

Read: the correctness fix costs ~8% (~35 µs) on a *fully instrumented*
startup, only as the packages load, and ~19% in steady state per startup.
Warm is the pessimistic lens: production never calls `getHooks` twice for
the same name in one process, so the cold number is the production cost.
The warm gap is real and instructive — the dedupe pays a Set lookup per
list entry plus a (versionRange, filePath) key string per match, which
costs more after JIT than the scan's extra duplicate allocations, even
while saving 78 registrations per startup. A process using a single
integration family pays one query's share of the delta: a few µs, once.

Run with:

```sh
cd benchmark/sirun/instrument-get-hooks
node ../run-all-variants.js
```
