# Stage 28: review test repair

Date: 2026-07-14 UTC

## Result

Stage 28 passes. All three missing Stage 27 boundary cases were added before production behavior was changed. The
new OTel user-child test failed against Stage 26's trace-wide suppression with one exported span instead of two,
proving that an unrelated user OTel child was incorrectly dropped. The repaired implementation and all three new
test groups now pass.

## Repair

Stage 26 set `nativeTrace.record=false`. That muted the complete native Genkit trace, including unrelated user OTel
children created within an action. Stage 28 replaces this with two internal symbols in
`packages/dd-trace/src/opentelemetry/suppression.js`:

- `suppressOtelInstrumentation` names the one OTel instrumentation scope to suppress;
- `preserveOtelContext` keeps the already-stored native context while the integration-owned Datadog span is active.

With OTel enabled, the exact Genkit hook places `genkit-tracer` in the active Datadog store. The OTel bridge checks
that value against `Tracer.instrumentationLibrary.name`. Only an exact match returns a valid non-recording span,
using the authoritative Datadog span context when present. Genkit can still read trace/span IDs, but its native span
does not record or export raw `genkit:input`, `genkit:output`, or vector attributes.

An unrelated tracer such as `user-library` does not match `genkit-tracer`; it creates a normal recordable OTel span.
The stored non-recording Genkit context carries the authoritative trace/span IDs, so the user span exports as a
direct child of the authoritative Genkit Datadog span. There is no trace-wide recording flag and no Genkit name in
shared OTel bridge code.

Ignored Genkit labels also return a store carrying the suppression scope, preventing native util/prompt spans while
preserving the ambient selected Datadog parent for later model/tool/retrieval/embedding actions.

## Added coverage

1. **Unrelated OTel child:** under `DD_TRACE_OTEL_ENABLED=true`, a real local Genkit model creates a
   `user-library` OTel child. The trace contains exactly the authoritative Genkit span and user span; the user span
   is parented to Genkit and retains its user attribute, with no native raw Genkit tags.
2. **Context-manager contract:** direct unit tests pin marked+stored preservation, marked without stored fallback,
   and the unmarked+stored control path.
3. **Scope suppression:** a direct OTel tracer test proves the selected instrumentation scope is non-recording while
   a different scope remains a real child of the authoritative Datadog span.
4. **Unowned provider:** with `google-genai` LLMObs disabled, `googleai/unowned-model` remains a Genkit-owned `llm`
   event with provider `google`, full registered model name, and all three token metrics.

## Architecture score

Baseline (trace-wide `record=false`) to proposal (scope-specific non-recording bridge span):

| Dimension | Baseline | Proposal | Reason |
| --- | ---: | ---: | --- |
| Drift prevention | 5 | 9 | One shared symbol module defines the producer/consumer contract; no duplicated string symbols. |
| Module coupling | 6 | 9 | Shared OTel code compares generic instrumentation-scope names and contains no Genkit-specific branch. |
| Explicit contracts | 5 | 9 | Store scope, context preservation, exact-match suppression, and fallback behavior are directly encoded. |
| Testability at boundaries | 5 | 10 | Integration plus direct ContextManager/Tracer tests cover match, mismatch, stored, and missing-stored paths. |
| Extensibility | 5 | 9 | Another integration can suppress only its native OTel scope without altering the bridge. |
| Hot-path fitness | 7 | 9 | One optional store lookup/string equality precedes normal OTel span creation; no promise or trace-array work. |

The proposal clears the required 8/10 bar on all six dimensions. It preserves public OTel behavior and avoids a
new public API; the symbols are internal repository contracts.

## Validation

Default exact-version Genkit APM and LLMObs:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
```

Result: `22 passing (1s)`. Log: `28-attempts/focused-default.log`.

OTel-enabled exact-version Genkit APM and LLMObs:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  DD_TRACE_OTEL_ENABLED=true ./node_modules/.bin/mocha \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
```

Result: `22 passing (1s)`. Log: `28-attempts/focused-otel-enabled.log`.

OTel shared-core regression suites:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha \
  packages/dd-trace/test/opentelemetry/context_manager.spec.js \
  packages/dd-trace/test/opentelemetry/tracer.spec.js
```

Result: `49 passing (144ms)`. Log: `28-attempts/otel-core-final.log`.

Targeted ESLint, syntax checks for all modified/new JavaScript files, and `git diff --check` passed without output.
No test was removed, skipped, weakened, or given a larger timeout. Pipeline progress was not edited by this worker.

## Handoff

No Stage 28 blocker remains. Compatibility remains intentionally exact at Genkit/core `1.21.0`; a future change to
Genkit's OTel instrumentation scope name requires source/runtime evidence and a corresponding constant update in the
integration plugin.
