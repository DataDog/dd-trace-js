# Stage 34: final live Genkit observability

Date: 2026-07-14 UTC

## Result

**Passed.** The unchanged real sample application at `09-sample-app/sample-app.js` ran against the current built
tracer with `genkit@1.21.0` and `DD_TRACE_OTEL_ENABLED=true`. The repository mock trace agent captured the actual
msgpack APM intake and LLMObs intake emitted by the tracer. This is application telemetry, not a unit-test assertion
or a synthetic plugin invocation.

The sample completed all 14 declared application cases: seven successful cases and seven expected-error cases,
with zero unexpected errors. The trace agent captured 21 authoritative APM spans and 21 LLMObs span events. The
additional action beyond the 14 top-level sample cases is expected: the workflow expands into a flow step,
retrieval, embedding, two model turns, and a tool call, and the interrupt case executes the `approvalRequired` tool.

The frozen final-gate source diff is unchanged:

```text
2f18329cc57421c538109e8fab5a216cd52a6f36a1ba2d1d3d547a3948bf1422
```

## Reproduction

Run from `/workspace/repo`:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  DD_TRACE_OTEL_ENABLED=true \
  SOURCE_DIFF_SHA256=2f18329cc57421c538109e8fab5a216cd52a6f36a1ba2d1d3d547a3948bf1422 \
  node .dd-apm-evidence/genkit/34-live-capture.js \
  > .dd-apm-evidence/genkit/34-live-run.log 2>&1

node .dd-apm-evidence/genkit/34-validate-capture.js \
  > .dd-apm-evidence/genkit/34-validation.log
```

The stage-local runner starts `packages/dd-trace/test/plugins/agent.js`, initializes the current repository tracer
with the Genkit plugin and LLMObs (`mlApp: genkit-live-sample`, agentless disabled), subscribes to APM intake, and
then requires the unchanged sample. The sample's own local dependency tree resolves:

```text
genkit              1.21.0
@genkit-ai/core     1.21.0
dd-trace            7.0.0-pre (current workspace build)
Node.js             v22.23.1
```

Exact resolution paths and tool versions are in `34-runtime-provenance.log`. The sample source SHA-256 is
`f8d67bb23ad652d69b88fcfdf9045ac06af65e98498775abb33531ac42821e14`, unchanged from the Stage 9 application.

## Captured telemetry

Raw evidence:

- `34-sample-results.json`: all 14 application results, including stream chunk order and expected errors.
- `34-apm-traces.json`: 15 actual APM intake requests containing 21 spans.
- `34-llmobs-requests.json`: two actual LLMObs intake batches containing 21 span events.
- `34-llmobs-span-index.json`: readable projection of every LLMObs event with IDs, parent, kind, I/O, model,
  provider, metadata, metrics, and error.
- `34-observability-validation.json`: machine-checked counts and invariants.

LLMObs kinds observed:

| Kind | Count | Operations represented |
| --- | ---: | --- |
| `llm` | 7 | generation success/error, streaming success/error, two workflow model turns, interrupt model turn |
| `workflow` | 4 | flow, named flow step, flow error, flow-step error |
| `tool` | 4 | workflow tool, direct tool, tool error, interrupting tool |
| `retrieval` | 3 | workflow retrieval, direct retrieval, retrieval error |
| `embedding` | 3 | workflow embedding, direct embedding, embedding error |

All 21 LLMObs `span_id` values match exactly one of the 21 authoritative APM span IDs, and all event names match
the corresponding APM resources. APM operation names are limited to `genkit.request`, `genkit.tool`, and
`genkit.workflow`; no native Genkit OTel span appears in the capture despite OTel being enabled.

## Semantic inspection

### Generation and streaming

All seven model events are named `local/offline-model` with `model_name=local/offline-model` and
`model_provider=custom`, the correct identity for the sample's local registered model. Five successful model events
carry numeric `input_tokens`, `output_tokens`, and `total_tokens`; the two model errors carry no fabricated token
metrics.

The streaming result records the ordered chunks `offline ` and `stream complete`, then
`streamCompleted=true`, `finalResponseAwaited=true`, and final output `Offline generation complete.`. Its LLMObs
event contains that final output, not a partial chunk, with metrics `11/7/18`. The streaming-error event records the
input and an empty output plus the real `Error` type, message, and stack.

### Workflow hierarchy and tool loop

The captured workflow relationship is concrete:

```text
offlineWorkflow       span 9118969867863512626
└─ offlineFlowStep    span 4169964900330121175
   ├─ localRetriever
   ├─ localEmbedder
   ├─ local/offline-model (tool request)
   ├─ lookupWeather
   └─ local/offline-model (final response)
```

The same parent IDs are present in both APM and LLMObs data. The first workflow model event contains a normalized
`lookupWeather` tool call, the tool event contains its structured input/output, and the second model event contains
the assistant tool call plus normalized tool result before the final assistant answer.

### Retrieval, embeddings, tools, and errors

The standalone retrieval event captures input `offline retrieval query` and the reviewed document fields `text`,
`name`, `id`, and numeric `score`. It excludes `excludedSecret`. The standalone embedding event captures two input
documents and output `[2 embedding(s) returned with size 3]`, with model name `localEmbedder` and provider
`custom`; no vector values are serialized. The direct `lookupWeather` event captures the Berlin input and complete
deterministic result.

Eight APM spans and eight LLMObs events are error-marked: the seven expected-error sample cases plus the
`ToolInterruptError` raised internally by the interrupting tool (the top-level Genkit result is correctly
`finishReason=interrupted`). Every error event has a type and stack; ordinary runner errors also retain their
messages.

## Duplicate and privacy inspection

The machine validator proves:

- one LLMObs event per authoritative APM span ID, with no duplicate IDs;
- no native Genkit OTel spans when the bridge is enabled;
- no raw `genkit:input` or `genkit:output` APM tags;
- no serialized embedding arrays or vector values in LLMObs intake;
- no `do-not-capture` or `excludedSecret` values in LLMObs intake;
- exact workflow/step/action parent-child relationships;
- error and streaming completion fields are present in the stored payloads.

Raw artifact SHA-256 values:

```text
b7240a1f310576573502642bb47bebeb49e46c7b8368da8a9adcce8bcea3fe7d  34-apm-traces.json
274d85d62c72684ec8633a54caf1ae3b61c21c2ba215cdcb20b6af15b8e0bac3  34-llmobs-requests.json
2b5a68ebac34011b010a8164834d86bfa4c4a7ce64df4dda7944830669c1572c  34-llmobs-span-index.json
87bb97245dc24c97dfc814d17fd43f07ce3b8d9347fee84ea6b341e93bed9d14  34-sample-results.json
```

No credentials, provider network, Docker service, or Datadog backend was needed because Genkit is classified as an
orchestration framework and this exact-version sample uses real registered local Genkit actions. There is no
remaining Stage 34 capability blocker.
