# What causal attribution costs in JS line coverage

A spike, not tracer code. It measures the cost of learning the async context at repo function
entries, and how often a cheaper design that checks less often would credit a line to the wrong test.

Designs:

- **A**: check the context only at a module's first entry after a test boundary and at
  `await`/`yield` resumption.
- **B**: check `storage('legacy').getHandle()` by identity at every repo function entry and resumption.
- **C**: a native addon (`cped.cc`) that compares V8's continuation-preserved embedder data by
  identity through the Fast API. It is meaningful only where `AsyncLocalStorage` keeps its state
  there (Node 24, or Node 22 with `--experimental-async-context-frame`).

Files:

- `bench.js`, `run.sh`: ns per check for B by Node version and V8 tier. Results in `table-b.jsonl`.
- `cped.cc`, `binding.gyp`, `bench-c.js`, `run-c.sh`: the same for C. Node's headers do not ship
  `v8-fast-api-calls.h`; copy it from `deps/v8/include` of the matching Node tag into `inc/` and
  add `"include_dirs": ["inc"]`. Results in `table-c.jsonl`.
- `hook.js`: a preload that inserts the check into every function entry and resumption of repo code
  compiled through `vm.Script` (Jest). `SPIKE_MODE=b` or `c` only checks. `SPIKE_MODE=gap` also
  simulates A and its variants against B as ground truth and writes per-process counts.
- `e2e.sh`: interleaved off/on wall-clock pairs, Test Optimization on in both. `gap.sh`: one gap run.
  `stats.py`: median paired difference with a bootstrap 95% CI. Raw pairs in `e2e-*.jsonl`.

Ground truth follows the accuracy definition: an entry belongs to test T only if it runs inside T's
window in a context that carries T; anything else is Shared.
