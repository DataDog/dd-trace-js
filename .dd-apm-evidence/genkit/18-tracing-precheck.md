# Stage 18: LLMObs tracing prerequisite

Date: 2026-07-14 UTC

## Result

The tracing prerequisite **passes**. The repository contains a registered Genkit instrumentation and tracing plugin,
the rewriter hooks the exact installed `@genkit-ai/core@1.21.0` implementation, and both focused validation suites
pass after removing telemetry exporter variables and the initially present empty `DD_AGENT_HOST` variable.

No production or test file was changed during this stage. LLMObs behavior was not evaluated; this gate establishes
only that the APM span required by a later `LLMObsPlugin` exists and has a passing lifecycle.

## Static verification

- `packages/datadog-instrumentations/src/genkit.js` registers every hook returned by
  `getHooks('@genkit-ai/core')`.
- `packages/datadog-instrumentations/src/helpers/hooks.js` registers `@genkit-ai/core` with `esmFirst: true`.
- The rewriter index includes the Genkit configuration.
- The Genkit rewriter configuration has two exact-version Orchestrion `Async` entries for named function
  `runInNewSpan`, channel `runInNewSpan`:
  - `lib/tracing/instrumentation.js`
  - `lib/tracing/instrumentation.mjs`
- Both installed runtime files under `versions/@genkit-ai/core@1.21.0/` contain the named async function.
- The fixture manifest pins both `genkit` and `@genkit-ai/core` to `1.21.0`.
- `packages/datadog-plugin-genkit/src/index.js` exports plugin id `genkit` with prefix
  `tracing:orchestrion:@genkit-ai/core:runInNewSpan`.
- The runtime registry maps both `genkit` and `@genkit-ai/core` to the Genkit plugin.
- External-version metadata, public TypeScript surfaces, docs, and APM CI registration all contain Genkit entries.

The structured assertion printed:

```json
{
  "coreVersion": "1.21.0",
  "coreRoot": "/workspace/repo/versions/@genkit-ai/core@1.21.0/node_modules/@genkit-ai/core",
  "hookCount": 2,
  "files": [
    "lib/tracing/instrumentation.js",
    "lib/tracing/instrumentation.mjs"
  ],
  "pluginId": "genkit",
  "prefix": "tracing:orchestrion:@genkit-ai/core:runInNewSpan",
  "registry": ["genkit", "@genkit-ai/core"]
}
```

## Focused tracing test

Before the test, the shell contained `DD_AGENT_HOST=`. The command explicitly removed it and all OTEL exporter
variables so spans could not bypass the local test agent:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha packages/datadog-plugin-genkit/test/index.spec.js
```

Exit code: `0`. Result: `5 passing (1s)` against `@genkit-ai/core 1.21.0 (1.21.0)`.

Passing cases:

1. model actions;
2. flows and named flow steps, including the step-to-flow parent relationship;
3. tool actions;
4. retriever actions;
5. embedder actions.

The test emitted non-failing load-order diagnostic warnings for Mocha and common test-server dependencies loaded
before `dd-trace`. The Genkit integration loaded and all assertions passed; these warnings do not indicate an agent
connection or Genkit hook failure.

## Plugin structure test

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha packages/dd-trace/test/plugins/plugin-structure.spec.js
```

Exit code: `0`. Result: `171 passing (47ms)`. The suite specifically recognized
`datadog-plugin-genkit`, its matching instrumentation file, hook accounting, runtime registry id, TypeScript entry,
and documentation alignment.

## Reproduction

Run the two test commands above from `/workspace/repo`. Static checks can be reproduced with:

```sh
node -e "const x=require('./packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/genkit'); console.log(JSON.stringify(x,null,2))"
rg -n "@genkit-ai/core|genkit" \
  packages/datadog-instrumentations/src/helpers/hooks.js \
  packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js \
  packages/dd-trace/src/plugins/index.js \
  packages/dd-trace/test/plugins/externals.js \
  packages/dd-trace/test/plugins/versions/package.json \
  index.d.ts index.d.v5.ts docs/test.ts docs/API.md .github/workflows/apm-integrations.yml
git diff --check
```

`git diff --check` exited `0`.

## Blockers

None for the tracing prerequisite. This result does not claim that LLMObs plugins, semantic tags, streaming
completion, or live trace capture pass; those belong to later pipeline stages.
