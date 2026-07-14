# Stage 21: Genkit LLMObs behavior diagnosis

Date: 2026-07-14 UTC

## Result

The exact environment-scrubbed LLMObs suite passed on its single mandated run: **13 passing, 0 failing, 0 pending**,
exit code 0. The primary failure mode is `null`; there are no span-event, tag, message-format, token-count, plugin
loading, cassette, utility, or runtime failures to hand to Stage 22.

The repository emitted its known non-failing diagnostics about Mocha and test-server dependencies loading before
`dd-trace`. These did not prevent the `genkit` integration from loading, and every assertion completed.

## Command

Run once from `/workspace/repo`:

```sh
env -u OTEL_TRACES_EXPORTER \
  -u OTEL_LOGS_EXPORTER \
  -u OTEL_METRICS_EXPORTER \
  -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha --timeout 20000 packages/datadog-plugin-genkit/test/llmobs.spec.js
```

The full authoritative transcript is `21-test-output.log`.

## Coverage assessment

The suite is complete for the exact `genkit@1.21.0` / `@genkit-ai/core@1.21.0` Stage 12 and Stage 19 implementation
contract. It covers all five selected kinds (`llm`, `workflow`, `tool`, `retrieval`, and `embedding`) and does not
invent an `agent` span. Specifically, it pins:

- generation normalization, tools, token metrics, scalar metadata, success, and runner errors;
- fully consumed streaming through final response plus streaming rejection;
- flow and named flow-step I/O, errors, and parent relationships;
- tool success, runner errors, and the exact-version interrupt contract;
- retrieval document conversion, errors, and reviewed metadata fields;
- embedding document conversion, errors, count/dimension summarization, and vector omission;
- selected parenting through ignored native labels;
- valid and malformed serialized-output fallback behavior;
- the runtime-observed two-argument action paths and source-supported three-argument overload;
- absence of sentinel secrets, unsafe media/data, unsupported usage, and vector values from emitted events.

No missing Stage 21 unit cases were identified. Input/output schema-validation failures remain an explicitly
documented limitation of the selected hook rather than untested behavior claimed by the plugin.

## Gates outside this diagnosis

This green unit suite does not resolve native Genkit OpenTelemetry versus Datadog APM duplication, supported-provider
LLMObs duplication/token ownership, or a version range broader than exact `1.21.0`. Those require the final
instrumented real-application observability and compatibility gates and do not make the Stage 21 behavior suite
incomplete.

No production file, test file, or `PROGRESS.md` was modified.
