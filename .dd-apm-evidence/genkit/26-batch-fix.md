# Stage 26: batch review fixes

Date: 2026-07-14 UTC

## Result

All three Stage 25 blockers are fixed. No todo was skipped or deferred.

### GENKIT-BATCH-001: model and embedder identity

Model and embedder LLMObs registrations now use the exact registered Genkit action name as `modelName`. Custom
actions such as `local/normalization-model` and `localEmbedder` retain that identity rather than falling back to
`custom`. Unknown providers remain unset and therefore keep the backend's `custom` provider fallback.

The only provider prefix mapped by this change is `googleai/`: exact Genkit 1.21.0 source documents registered
action names as `pluginId/actionId`, and its exact registry/source examples use `googleai/gemini-*`. That prefix is
mapped to provider `google` and the existing `google-genai` integration. No provider is inferred from arbitrary
action-name prefixes.

### GENKIT-BATCH-002: provider ownership

For a `googleai/` model action, the Genkit plugin checks the current plugin manager at call time. When the supported
`google-genai` LLMObs member is enabled, the Genkit action becomes a `workflow` wrapper and uses workflow text I/O.
It does not apply LLM token metrics, leaving the underlying provider integration as the sole authoritative `llm`
span and token owner. Custom and uninstrumented actions remain Genkit-owned `llm` spans with their registered model
identity and Genkit token metrics.

The exact-version test enables a provider owner in the real plugin manager, runs a real Genkit model action, and
asserts `workflow` kind plus an empty metrics object.

### GENKIT-BATCH-003: OTel duplicate and payload suppression

When `DD_TRACE_OTEL_ENABLED=true`, the tracing plugin wraps only the exact Genkit `runInNewSpan` callback. It marks
the distinct native Genkit bridge trace `record=false`, while executing Genkit's callback under the authoritative
Datadog legacy store. Ignored Genkit `util`/prompt spans use the same suppression path, which is required for
streaming and tool-loop operations.

Nested native OTel context is preserved with an internal symbol on the authoritative Datadog span. The OTel context
manager honors that marker only when a native OTel context is already stored; this prevents nested native Genkit
spans from being reparented onto the authoritative Datadog trace. User callbacks still run under the Datadog span,
so selected flow, flow-step, model, tool, retrieval, and embedding parenting remains intact. The native trace is not
exported, so its raw `genkit:input`, `genkit:output`, and numeric embedding-vector attributes cannot leak to APM.
This does not globally disable OTel or change unrelated user-created OTel spans.

The OTel-enabled exact-version suites cover flow/flow-step nesting, streaming success/error, tool interrupts,
ignored-label parenting, and a dedicated embedder assertion that receives exactly one safe authoritative span and
contains no raw input/output/vector tags.

## Architecture score

The shared context-manager marker is a narrow internal contract between the Genkit tracing plugin and the Datadog
OTel bridge. Baseline (suppress only the native root trace, which broke nested selected spans) to proposal:

| Dimension | Baseline | Proposal | Reason |
| --- | ---: | ---: | --- |
| Drift prevention | 5 | 9 | One symbol controls the only context-preservation decision; Genkit does not duplicate OTel context logic. |
| Module coupling | 5 | 8 | The contract is one internal `Symbol.for` marker, not a Genkit import or public API in the OTel bridge. |
| Explicit contracts | 4 | 9 | The marker's meaning and the stored-context precondition are encoded at both producer and consumer sites. |
| Testability at boundaries | 5 | 9 | Exact OTel-enabled Genkit tests pin topology/privacy; all 26 context-manager tests remain green. |
| Extensibility | 5 | 8 | Another framework can opt into the same narrow context behavior without adding integration-specific bridge code. |
| Hot-path fitness | 6 | 9 | One symbol property check occurs only when both a stored OTel span and active Datadog span exist. |

The alternative of naming Genkit in `ContextManager` was rejected because it would couple the OTel bridge to one
integration. Globally disabling OTel was rejected because it would break user instrumentation. The marker instead
preserves an already-active native context only for the lifetime of the selected framework-owned Datadog span.

## Validation

From `/workspace/repo`:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
```

Result: `20 passing (1s)`. Full output: `26-attempts/focused-default.log`.

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  DD_TRACE_OTEL_ENABLED=true ./node_modules/.bin/mocha \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
```

Result: `20 passing (1s)`. Full output: `26-attempts/focused-otel-enabled-final.log`.

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha packages/dd-trace/test/opentelemetry/context_manager.spec.js
```

Result: `26 passing`. Full output: `26-attempts/context-manager.log`.

Targeted ESLint, `node --check` for all five modified JavaScript files, and `git diff --check` all passed with no
output. Pipeline progress was not edited by this Stage 26 worker.

## Review handoff

No Stage 26 blocker remains. Stage 27/29 should still review the internal symbol contract and callback wrapping for
compatibility with future OTel bridge changes, and should retain exact `1.21.0` compatibility until broader Genkit
source/runtime evidence exists. The `googleai/` ownership mapping is intentionally the only supported prefix; new
provider mappings require source proof plus an enabled matching provider LLMObs integration.
