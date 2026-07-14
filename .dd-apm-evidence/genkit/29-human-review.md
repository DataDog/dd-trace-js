# Stage 29: human-quality gate

Date: 2026-07-14 UTC

## Result

**Gate status: blocked / changes required.**

This environment did not provide a human reviewer or an approval mechanism. The review performed here is an
independent automated engineering review and must not be represented as literal human approval. Consequently the
stage's stated objective, "Human approval", is unavailable and is not marked passed.

The automated review also found one PR-blocking correctness issue in the OTel-enabled ignored-Genkit-span path.
The remaining reviewed areas and the current focused tests are green.

## Blocking finding

### GENKIT-HUMAN-001 — high — ignored spans permanently mark an ambient user span

`GenkitTracingPlugin.bindStart()` sends unselected Genkit spans through `#suppressNativeGenkitSpan(currentStore)`
when `DD_TRACE_OTEL_ENABLED` is enabled (`packages/datadog-plugin-genkit/src/tracing.js:41-45`). The helper writes
`preserveOtelContext` directly onto `authoritativeStore.span` (`tracing.js:77-82`). For an ignored `util`, prompt,
or other unselected span, that span can be an ambient user-owned Datadog span rather than a Genkit span.

The property is never removed. Later, while the same user span remains active, `ContextManager.active()` sees the
marker and prefers any stored OTel span (`packages/dd-trace/src/opentelemetry/context_manager.js:42-47`). Thus a
completed ignored Genkit operation can change unrelated OTel context resolution for the rest of the ambient user
span. Stage 28's context-manager tests set the marker deliberately and test its branch, but do not pin marker
lifetime or the ignored-operation-aftereffect.

Exact-version reproduction (run with OTel enabled) printed an unset value before an ignored real
`@genkit-ai/core@1.21.0` `runInNewSpan` call and `true` afterward:

```text
{}
{"after":true}
```

Required resolution: scope context preservation to the store returned for the Genkit operation, or otherwise
restore/remove it deterministically. Do not persist the contract on an ambient user span. Add a regression that
runs an ignored Genkit span inside a user Datadog span and proves subsequent unrelated stored OTel context uses the
normal active-Datadog-span behavior.

## Automated review coverage

Reviewed the complete source change from original base `372e5eb61c4c6a13662ad2f8780a87275b50314d`, including:

- exact `@genkit-ai/core@1.21.0` CJS/MJS Orchestrion hooks and dependency registration;
- APM operation allowlist, span names/kinds, safe APM tags, errors, streaming completion, and parenting;
- LLMObs `llm`, `workflow`, `tool`, `retrieval`, and `embedding` I/O, metrics, provider ownership, errors, and privacy;
- instrumentation-scope OTel suppression, user OTel child preservation, and native payload/vector suppression;
- plugin/config/types/docs/fixture/CI registrations and exact-version compatibility scope;
- default, OTel-enabled, and shared OTel bridge regression suites.

No additional automated blocker was found in model/embedder identity, provider demotion, vector omission, composite
lifecycle, registration, or exact-version scope. Compatibility remains intentionally limited to exactly `1.21.0`.

## Read-only validation

Commands run from `/workspace/repo`:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha --timeout 20000 \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
# 22 passing

env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  DD_TRACE_OTEL_ENABLED=true ./node_modules/.bin/mocha --timeout 20000 \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
# 22 passing

env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha \
  packages/dd-trace/test/opentelemetry/context_manager.spec.js \
  packages/dd-trace/test/opentelemetry/tracer.spec.js
# 49 passing

git diff --check 372e5eb61c4c6a13662ad2f8780a87275b50314d -- . \
  ':(exclude).dd-apm-pipeline/**' ':(exclude).dd-apm-evidence/**'
# exit 0
```

The marker-lifetime reproduction initialized real `genkit@1.21.0`, invoked the exact ignored `runInNewSpan`
surface inside `tracer.trace('user-owned-parent', ...)`, and inspected
`Symbol.for('dd-trace.otel.preserve_context')` before and after.

## Capability and handoff

- Automated engineering review: **completed; changes required**.
- Literal human review/approval: **unavailable; not passed**.
- Production/test files modified by Stage 29: **none**.
- `PROGRESS.md` modified by Stage 29 reviewer: **no**.
- Stage 30 must not finalize until GENKIT-HUMAN-001 is repaired, its focused and OTel bridge tests are rerun, and an
  actual human approval is supplied or the workflow owner explicitly waives/replaces that unavailable capability.
