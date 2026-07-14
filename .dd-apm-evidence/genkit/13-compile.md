# Stage 13: compile Genkit tracing integration

Date: 2026-07-14 UTC

## Result

The Stage 12 contract was compiled into a new APM-only Genkit integration baseline. No LLMObs plugin or LLMObs
tagging logic was added in this stage.

The instrumentation uses Orchestrion `Async` rewriting for the exact source-proven
`@genkit-ai/core@1.21.0` implementation files:

- `lib/tracing/instrumentation.js`
- `lib/tracing/instrumentation.mjs`

Both entries target the named `runInNewSpan` function and publish to the shared
`orchestrion:@genkit-ai/core:runInNewSpan` tracing channel. Direct transformation checks against the retained exact
package produced `__apm$wrapped` in both outputs and found the expected channel name.

The tracing plugin strictly allows only model, flow, flow-step, tool, retriever, and embedder native labels. It emits
`genkit.request`, `genkit.workflow`, and `genkit.tool` spans with only safe APM metadata: component, operation type,
action name, resource, span kind, and span type. It does not copy inputs, outputs, prompts, documents, provider raw
data, or embedding vectors into APM tags. Ignored Genkit spans return the ambient legacy store so unselected native
`util` and prompt spans do not sever Datadog parent context.

Runtime registry aliases, test-version metadata, public plugin types for v6 and v5, docs type coverage, supported
configuration metadata, generated config types, and an APM CI job were added. The initial real-package spec covers
model, flow plus flow-step, tool, retrieval, and embedding operations against exact `1.21.0` fixtures.

## Architecture score

Baseline (no Genkit boundary) to proposal (one shared Orchestrion boundary and one tracing plugin), out of 10:

| Dimension | Baseline | Proposal | Reason |
| --- | ---: | ---: | --- |
| Drift prevention | 0 | 9 | One allowlist and lifecycle handles all selected Genkit action subtypes. |
| Module coupling | 0 | 9 | Instrumentation communicates only through a diagnostic tracing channel. |
| Explicit contracts | 0 | 9 | Exact package version, exact files, named function, and label allowlist are encoded. |
| Testability at boundaries | 0 | 8 | Real-package tests cover every selected operation; activation failure remains explicit. |
| Extensibility | 0 | 9 | A future operation adds one mapping; later LLMObs subscribes to the same context. |
| Hot-path fitness | 0 | 9 | One rewrite, constant-time label lookup, and no payload serialization in APM. |

## Validation

Passing checks:

```text
node --check <four new JavaScript source/spec files>
  passed

npm exec -- eslint <targeted changed JavaScript files>
  passed, no output

./node_modules/.bin/mocha packages/dd-trace/test/plugins/plugin-structure.spec.js
  171 passing

npm run verify:config:types
  passed after npm run generate:config:types

git diff --check
  passed, no output

Orchestrion exact-source transformation:
  {"file":"lib/tracing/instrumentation.js","transformed":true,"channel":true}
  {"file":"lib/tracing/instrumentation.mjs","transformed":true,"channel":true}

CI YAML structural check:
  {"job":"genkit","runner":"ubuntu-latest","plugins":"genkit","steps":2}
```

Exact retained source hashes:

```text
94c7273234ec534218fa2f0cf62bbad1cf81bff90cb4cd11c91dc08b281b56d1  lib/tracing/instrumentation.js
2440821b3ddd852d495f3104fef83c51355919ac2f69eb6e48a6a0e5aa56175f  lib/tracing/instrumentation.mjs
```

Focused fixture installation passed:

```text
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
PLUGINS=genkit yarn services
success Saved lockfile.
Done in 34.44s.
```

## Test failure handed to Stage 14

The focused real-package test currently fails five cases by timeout:

```text
./node_modules/.bin/mocha packages/datadog-plugin-genkit/test/index.spec.js
0 passing, 5 failing
model, flow/flowStep, tool, retriever, and embedder: Timeout of 5000ms exceeded
```

The package call paths execute and the installed function is visibly rewritten (`__apm$wrapped` is present), but
the Genkit plugin is not instantiated when the dependency-file instrumentation load event occurs, so the emitted
channel has no subscribers and the agent receives no spans. The earlier missing `DD_TRACE_GENKIT_ENABLED` failure
was fixed by adding supported configuration metadata and regenerating config types. The embedder fixture's runner
shape was also corrected. The remaining activation mechanism is intentionally preserved for Stage 14 diagnosis;
no timeout was increased and no assertion was weakened.

## Other validation limitations

`node scripts/verify-ci-config.js` could not complete because it queries every integration from the public npm
registry and the existing `confluentinc-kafka-javascript` query returned HTTP 404. The Genkit job itself parses and
passes a local structural assertion shown above.

`npm run type:check` is blocked before checking project sources by existing TypeScript 6 diagnostics in
`tsconfig.dev.json`: deprecated `alwaysStrict=false` and `baseUrl` options require `ignoreDeprecations: "6.0"`.

## Changed production and test files

See `13-changed-files.json` for the complete list. Pipeline progress was not edited by this stage worker.
