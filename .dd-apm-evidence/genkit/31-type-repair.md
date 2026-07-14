# Stage 31: change-owned type repair

Date: 2026-07-14 UTC

## Result

All production diagnostics introduced by the Genkit/OTel change are repaired. The TypeScript 6 deprecation-bypassed
compiler still exits 2 because the repository contains existing type debt, but none of its remaining diagnostics
occur on a statement introduced by this integration.

The repair changes only three production files:

- `packages/dd-trace/src/llmobs/plugins/genkit/index.js`
- `packages/dd-trace/src/opentelemetry/context_manager.js`
- `packages/dd-trace/src/opentelemetry/tracer.js`

No behavior, test, tsconfig, or pipeline progress file was changed.

## Before classification

The complete compiler output was captured with:

```sh
./node_modules/.bin/tsc --noEmit -p tsconfig.dev.json --ignoreDeprecations 6.0
```

Before repair it reported 6,553 diagnostics across 989 files. Comparing every changed-production-file diagnostic
to original base `372e5eb61c4c6a13662ad2f8780a87275b50314d` identified seven diagnostics on introduced statements:

```text
packages/dd-trace/src/llmobs/plugins/genkit/index.js:186 TS2339 document.content
packages/dd-trace/src/llmobs/plugins/genkit/index.js:189 TS2339 document.content
packages/dd-trace/src/opentelemetry/context_manager.js:46 TS2538 preserveOtelContext symbol index
packages/dd-trace/src/opentelemetry/context_manager.js:47 TS2345 OTel store passed as Context
packages/dd-trace/src/opentelemetry/tracer.js:100 TS2538 suppressOtelInstrumentation symbol index
packages/dd-trace/src/opentelemetry/tracer.js:102 TS18048 possibly undefined legacy store
packages/dd-trace/src/opentelemetry/tracer.js:102 TS2339 untyped legacy-store span
```

The other 18 diagnostics in the modified shared OTel production files mapped to unchanged statements already
present at the original base. The new Genkit production file did not exist at the base, so its two diagnostics were
unambiguously introduced.

## Repair

- `getDocumentText` now uses its existing object validation to require the `content` property before reading it.
- The OTel context manager gives its cached OTel and legacy storage handles file-scope JSDoc types. The operation
  still reads the same stores and invokes the same methods; the new context-preservation branch is now typed as an
  OTel `Context` and symbol-keyed legacy store.
- The OTel tracer gives its cached legacy storage handle the same narrow file-scope store type and preserves the
  existing optional span access.

The storage annotations also eliminated seven pre-existing store-shape diagnostics in the same context-manager
boundary. No unrelated file or type debt was modified.

## After compiler result

The same full compiler command now reports 6,539 diagnostics across 988 files. Introduced production diagnostics:

```text
0
```

The remaining changed-production-file diagnostics are 11 errors on unchanged original-base statements:

```text
5  packages/dd-trace/src/opentelemetry/context_manager.js
6  packages/dd-trace/src/opentelemetry/tracer.js
0  packages/dd-trace/src/llmobs/plugins/genkit/index.js
```

They are existing shared OTel type debt (baggage shape, public OTel span versus internal bridge fields, trace-state
narrowing, internal span context fields, and link shape), not diagnostics introduced by this integration.

The canonical `npm run type:check` remains separately blocked before source checking by the existing TypeScript 6
`alwaysStrict=false` and `baseUrl` deprecation configuration recorded in the Stage 31 retry evidence.

## Validation

```sh
node --check packages/dd-trace/src/llmobs/plugins/genkit/index.js
node --check packages/dd-trace/src/opentelemetry/context_manager.js
node --check packages/dd-trace/src/opentelemetry/tracer.js

npm exec -- eslint \
  packages/dd-trace/src/llmobs/plugins/genkit/index.js \
  packages/dd-trace/src/opentelemetry/context_manager.js \
  packages/dd-trace/src/opentelemetry/tracer.js

env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha --timeout 20000 \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
# 23 passing

env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha \
  packages/dd-trace/test/opentelemetry/context_manager.spec.js \
  packages/dd-trace/test/opentelemetry/tracer.spec.js
# 49 passing

git diff --check
```

Syntax, targeted ESLint, both test commands, and whitespace validation passed.
