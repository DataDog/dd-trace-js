# instrument-get-hooks

Measures the end-to-end hook-resolution cost of one tracer startup for
`getHooks` in `packages/datadog-instrumentations/src/helpers/instrument.js`:
every rewriter-based integration calls it once at require time, one call per
rewriter-instrumented module (23 calls per traced process).

Each loop iteration simulates one complete startup, inside the measured window:
the `indexed` variant (re)builds the startup index and then resolves hooks for
every rewriter-instrumented module once — matching the production lookup count
— while the `scan` variant resolves the same names with the pre-index
implementation, which has no startup cost of its own. Keeping the index
construction in the measurement matters: production never calls `getHooks` in
a hot loop, so a synthetic per-call loop would amortize the index build away
and misrepresent the trade.

- `scan` — the pre-index implementation, kept verbatim as the baseline. Full
  map → filter → map over the rewriter list per call, with a nested
  `names.includes`.
- `indexed` — the name-indexed implementation, also verbatim: one startup pass
  dedupes the hooks by (versionRange, filePath) into a `Map`, then each call is
  a lookup plus a defensive copy of the cached hooks.

Both implementations are frozen references over the real rewriter
instrumentation list: the setup assertions prove their outputs are equivalent
(up to the dedupe the index introduces) before anything is measured.

Measured (Node v26.2.0, warm, 20 000 simulated startups):

| | per startup |
|---|---|
| `scan` | ~65 µs (resolves 193 hook objects) |
| `indexed` | ~13 µs (resolves 81 hook objects, index build included) |

The one-time cold cost of the index build (paid once at require, before the
JIT warms up) is on the order of ~0.1–0.3 ms; it is part of the measured
per-startup figure above in its warm form.

The optimization that ships the indexed implementation in
`helpers/instrument.js` is stacked on this branch. The benchmark deliberately
stays self-contained rather than requiring the shipped helper: the shipped
implementation builds its index at require time, outside any in-process
measured window, so requiring it would reintroduce exactly the
measurement-boundary problem this design exists to avoid.

The `startup-guard` ceiling is relaxed to 30% for the `indexed` variant: its
loop is shorter by the size of the win itself (~5× fewer instructions per
startup), and the guard's purpose (catching a bench that rots into measuring
startup) is still enforced by the setup assertions plus the identical
`STARTUPS` per variant.

Run with:

```sh
cd benchmark/sirun/instrument-get-hooks
node ../run-all-variants.js
```
