# instrument-get-hooks

Measures the per-call cost of `getHooks` in
`packages/datadog-instrumentations/src/helpers/instrument.js`, which every
rewriter-based integration calls once at require time to look up its module
hooks (15+ calls per traced process).

Both implementations are kept in the bench so it runs standalone, over the real
rewriter instrumentation list:

- `scan` — the pre-index implementation, kept verbatim as the baseline. Full
  map → filter → map over the list per call, with a nested `names.includes`.
- `indexed` — the name-indexed implementation, also verbatim: one startup pass
  dedupes the hooks by (versionRange, filePath) into a `Map`, then each call is
  a lookup plus a defensive copy of the cached hooks.

Measured (Node v26.2.0, warm, 1M calls across all 23 rewriter-instrumented
module names): `scan` ~1.24µs/call, `indexed` ~0.14µs/call (~9×), one-time index
build ~84µs. The optimization that ships the indexed implementation in
`helpers/instrument.js` is stacked on this branch and repoints the `indexed`
variant at the shipped helper, so the bench keeps tracking production code once
it lands.

The `startup-guard` ceiling is relaxed to 30% for the `indexed` variant: its
loop is intentionally ~100× shorter than the scan baseline, which is precisely
the win, and the guard's purpose (catching a bench that rots into measuring
startup) is still enforced by the setup assertions plus the identical `CALLS`
per variant.

Run with:

```sh
cd benchmark/sirun/instrument-get-hooks
node ../run-all-variants.js
```
