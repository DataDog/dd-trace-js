# Stage 27: repaired-test diagnosis

Date: 2026-07-14 UTC

## Result

All requested test processes pass, but coverage is not yet comprehensive. Structured status:

```text
success=true
integration_complete=false
failure_mode=null
passing=66
failing=0
pending=0
```

The three Stage 26 repairs work for their currently tested paths:

- Named custom model and embedder events retain their registered names rather than `custom` model identity.
- Exact-source-proven `googleai/` actions are demoted to `workflow` with no Genkit token metrics when an enabled
  `google-genai` LLMObs member owns the provider request.
- With `DD_TRACE_OTEL_ENABLED=true`, selected Genkit operations keep one authoritative Datadog topology; the native
  Genkit bridge span is absent, selected nesting/streaming/errors/interrupts remain green, and the embedder APM
  assertion excludes native `genkit:input`, `genkit:output`, and numeric vector payloads.

## Commands and authoritative counts

Default exact-version Genkit APM and LLMObs:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
```

Result: `20 passing (1s)`, exit 0. Log: `27-attempts/focused-default.log`.

OTel-enabled exact-version Genkit APM and LLMObs:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  DD_TRACE_OTEL_ENABLED=true ./node_modules/.bin/mocha \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
```

Result: `20 passing (1s)`, exit 0. Log: `27-attempts/focused-otel-enabled.log`.

Context manager:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha packages/dd-trace/test/opentelemetry/context_manager.spec.js
```

Result: `26 passing (128ms)`, exit 0. Log: `27-attempts/context-manager.log`.

Each requested suite was run once by this stage.

## Coverage diagnosis

### High: unrelated user OTel child inside Genkit is untested

The fix suppresses the native Genkit trace by setting its internal Datadog trace `record=false`. That flag applies
to the trace, not only one span. The context-manager marker intentionally returns the stored native OTel context
while the authoritative Genkit Datadog span is active. Therefore an unrelated user-created OTel child inside the
Genkit callback is a critical boundary: it may inherit the suppressed native trace. The Stage 26 claim that
unrelated OTel spans remain unchanged is not pinned by any test.

Add an OTel-enabled Genkit integration case that creates a normal user OTel span inside the action. It must prove
the native Genkit bridge span remains hidden while the user span is exported and correctly parented. If it fails,
the implementation—not the assertion—must be narrowed.

### High: the shared context-manager contract lacks direct tests

`ContextManager.active()` now has a new shared-core branch for
`Symbol.for('dd-trace.otel.preserve_context')`, but `context_manager.spec.js` contains no test for that symbol or
branch. Its 26 passing tests are regressions for pre-existing behavior only. Add boundary tests for:

1. marked active Datadog span plus stored native OTel span returns the stored context;
2. marked active Datadog span without a stored native span uses normal proxy behavior;
3. unmarked active Datadog span plus stored native span uses normal proxy behavior.

### Medium: only provider-owned `googleai/` is tested

Exact source supports the `googleai/` convention (`pluginId/actionId` normalization and exact examples such as
`googleai/gemini-*`). The test proves the enabled-provider demotion path. It does not prove the complementary path:
with `google-genai` LLMObs disabled, `googleai/provider-model` should remain a Genkit-owned `llm` span with
`model_provider=google`, the full registered model name, and Genkit token metrics.

## Failure classification

There is no current test failure, so `failure_mode` is `null`. `integration_complete` is false solely because the
three missing boundary cases above prevent comprehensive coverage of the repaired contracts.

No production code, tests, or pipeline progress was modified by this stage worker.
