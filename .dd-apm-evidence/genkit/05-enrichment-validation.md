# Stage 05: metadata enrichment validation

Date: 2026-07-13 UTC

## Result

- Stage 04 targets: 5
- Found and enriched: 5
- Missing: 0
- Defining package: `@genkit-ai/core@1.21.0`
- Module name: `@genkit-ai/core`
- Source implementation: `src/tracing/instrumentation.ts:79`
- CommonJS implementation: `lib/tracing/instrumentation.js:41`
- ESM counterpart: `lib/tracing/instrumentation.mjs:14`
- Function shape: named async function declaration
- Export type: named export through `@genkit-ai/core/tracing`
- Orchestrion query: `{ functionName: 'runInNewSpan', kind: 'Async' }`

No Stage 04 correction was required. Stage 04 correctly included both published build artifacts. Enrichment adds an
important reachability detail: `@genkit-ai/core@1.21.0` declares an ESM `./tracing` entry at `lib/tracing.mjs`, but
that file re-exports `./tracing/instrumentation.js`. Consequently, ordinary Node CommonJS and ESM package usage both
execute the `.js` implementation. The matching `.mjs` implementation exists but is not directly exported by the
package map. It remains in `file_paths` for required dual-build completeness and nonstandard resolver/bundler paths.

## Hook registration implication

The Orchestrion configuration must use module name `@genkit-ai/core`, not top-level `genkit`, and package-relative
paths `lib/tracing/instrumentation.js` and `lib/tracing/instrumentation.mjs`. The integration instrumentation loader
must register `getHooks('@genkit-ai/core')` (or include it in an array passed to `getHooks`) before Genkit loads.
Registering only `getHooks('genkit')` will omit these dependency-file hooks. The deep implementation subpath need not
be publicly exported: `addHook`/the rewriter matches the internal package-relative file as it is loaded transitively.

## Validation commands

Run from `/workspace/repo`:

```sh
node -e "JSON.parse(require('node:fs').readFileSync('.dd-apm-evidence/genkit/05-enrichments.json')); console.log('valid JSON')"
node -e "const fs=require('node:fs'); const p='/tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/core/package.json'; const x=JSON.parse(fs.readFileSync(p)); console.log(x.name, x.version, x.exports['./tracing'])"
rg -n '^async function runInNewSpan' /tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/core/lib/tracing/instrumentation.{js,mjs}
rg -n 'runInNewSpan|tracing/instrumentation' /tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/core/{src/tracing/instrumentation.ts,lib/tracing.js,lib/tracing.mjs}
cd /tmp/dd-apm-genkit-1.21.0 && node -e "console.log(require.resolve('@genkit-ai/core/tracing'), typeof require('@genkit-ai/core/tracing').runInNewSpan)"
cd /tmp/dd-apm-genkit-1.21.0 && node --input-type=module -e "import('@genkit-ai/core/tracing').then(x => console.log(typeof x.runInNewSpan))"
sha256sum /tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/core/{package.json,src/tracing/instrumentation.ts,lib/tracing/instrumentation.js,lib/tracing/instrumentation.mjs,lib/tracing.js,lib/tracing.mjs}
```

Validation additionally compares every `target_name` to Stage 04, checks both runtime files and exact definition
lines, verifies one CommonJS and one ESM `file_paths` entry per target, and asserts `missing_targets` is empty.
