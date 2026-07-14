# Stage 11: runtime context mapping for `genkit@1.21.0`

Date: 2026-07-14 UTC

## Result

Stage 11 **passes** its runtime-context mapping gate. The exact Stage 09 CommonJS sample ran unchanged against
`genkit@1.21.0`, `@genkit-ai/core@1.21.0`, and `@genkit-ai/ai@1.21.0`. A stage-local Node preload proxied the real
exported `@genkit-ai/core/lib/tracing/instrumentation.js` `runInNewSpan` function before Genkit loaded. It recorded
real arguments, labels, mutable metadata before and after execution, result/error, native OpenTelemetry trace/span
IDs, and async nesting identities without modifying production or sample source.

The capture contains 28 total `runInNewSpan` calls and 21 selected calls:

| Operation | Captures | Success | Error |
| --- | ---: | ---: | ---: |
| generation | 7 | yes | yes |
| workflow / flow step | 4 | yes | yes |
| tool | 4 | yes | yes |
| retrieval | 3 | yes | yes |
| embedding | 3 | yes | yes |

`11-context-snapshot.json` is the sanitized runtime evidence. `11-context-mappings.json` maps all five operation
classes to APM-safe identifiers and LLMObs I/O/metric paths. `11-validate-context.cjs` asserts complete operation
coverage, success/error coverage, flow-step capture, nesting, interrupt semantics, numeric token metrics, and
secret/vector sanitization.

## Observed hook contract

Every sample call used the two-argument overload:

```text
ctx.arguments[0] -> opts ({ labels, metadata })
ctx.arguments[1] -> callback
ctx.result       -> resolved operation result
ctx.error        -> rejected operation error
```

The mutable post-execution values remain at `ctx.arguments[0].metadata`. At start, metadata usually contains only
`name`; before completion Genkit adds `path`, `metadata.subtype`, `input`, parsed `output` in the evidence capture,
`state`, and error flags. The real production value of `metadata.output` is a JSON string; the evidence sanitizer
parses it only to remove vectors/secrets and expose its safe structural paths.

The source-defined three-argument overload would place options at `ctx.arguments[1]`, but the exact sample did not
exercise it. That index remains source-derived and is not represented as runtime evidence.

## Semantic mappings

- Generation is selected by `labels['genkit:metadata:subtype'] === 'model'`. Input messages are at
  `metadata.input.messages`; output and usage are directly on `ctx.result`. The capture proves numeric
  `inputTokens`, `outputTokens`, and `totalTokens`. The local action name does not prove a provider convention, so
  provider/model fields remain unset rather than guessed.
- Workflows use subtype `flow`; named steps use the exact `labels['genkit:type'] === 'flowStep'` discriminator.
  Structured I/O is present at `metadata.input` and `ctx.result` but must remain LLMObs-only.
- Tools use subtype `tool`, with structured I/O at `metadata.input` and `ctx.result`.
- Retrieval input is `metadata.input.query`; output is `ctx.result.documents`. Document text is nested under
  `content[].text`; only reviewed scalar `name`, `id`, and `score` metadata may be copied.
- Embedding inputs are `metadata.input.input`; output is `ctx.result.embeddings`. The capture records only count and
  dimension structure and never stores numeric vectors.

Full executable context paths and required transforms are in `11-context-mappings.json`.

## Nesting evidence and corrections

Capture IDs and native trace/span IDs establish the main trace without relying on output order:

```text
flow 9
└─ flowStep 10
   ├─ retrieval 11
   ├─ embedding 12
   ├─ generate util 13
   │  ├─ first model 14
   │  └─ tool 15
   └─ recursive generate util 16
      └─ second model 17
```

The three tool-loop operations are ordered model → tool → model, but they are **not** a direct selected-span
parent-child chain. The first model and tool are siblings under an unselected `generate` util span; the second model
is under a recursive util span. At the selected-span level all three have the flow-step as their nearest selected
ancestor. Implementation/tests must reflect the observed tree rather than assert that the tool is the direct child
of the first model or direct parent of the second.

The beta interrupt fixture also resolves a prior ambiguity at this hook: the `approvalRequired` tool action rejects
with `ToolInterruptError` and its metadata state is `error`. Genkit catches that control-flow error above the tool
action and returns a successful outer generation response with `finishReason=interrupted`. A future plugin may
choose special interrupt tagging, but it must not claim the hook itself observes a successful tool result.

## Privacy handling

- Numeric embedding vectors are replaced by `{ omittedNumericVector: true, dimensions: N }`.
- Keys matching secrets, credentials, or authorization are replaced by `[redacted]`.
- `raw`, `custom`, `media`, and `data` values are omitted.
- Long strings are bounded to 500 characters.
- Token usage fields are retained because they are numeric observability metrics, not credentials.

Validation asserts the sample's `excludedSecret` value and numeric vector literals do not occur in the snapshot.

## Reproduction

From `/workspace/repo`:

```sh
cd .dd-apm-evidence/genkit/09-sample-app
env -i PATH="$PATH" HOME="$HOME" \
  GENKIT_CONTEXT_OUTPUT=/workspace/repo/.dd-apm-evidence/genkit/11-context-snapshot.json \
  RESULTS_PATH=/workspace/repo/.dd-apm-evidence/genkit/11-sample-results.json \
  NODE_OPTIONS=--require=/workspace/repo/.dd-apm-evidence/genkit/11-capture-context.cjs \
  node sample-app.js > /workspace/repo/.dd-apm-evidence/genkit/11-sample-output.txt 2>&1
cd /workspace/repo
node .dd-apm-evidence/genkit/11-validate-context.cjs
node --check .dd-apm-evidence/genkit/11-capture-context.cjs
node --check .dd-apm-evidence/genkit/11-validate-context.cjs
```

Validation output:

```json
{"selectedCaptureCount":21,"operationCounts":{"generation":7,"workflow":4,"retrieval":3,"embedding":3,"tool":4},"mappingCount":5,"successAndErrorCoverage":true,"flowStepCaptured":true,"nestingValidated":true,"interruptSemanticsCaptured":true,"vectorsAndSecretsSanitized":true}
```

The sample source SHA-256 remains
`f8d67bb23ad652d69b88fcfdf9045ac06af65e98498775abb33531ac42821e14`, exactly matching Stage 09 provenance.

## Limitations and downstream blockers

1. This is a stage-local proxy around the real function, not production instrumentation; it emits no Datadog APM
   or LLMObs spans.
2. Native OpenTelemetry/provider duplicate spans, provider-plugin model demotion, and token ownership remain for the
   final instrumented real-app observability gate.
3. Input schema errors before `runInNewSpan` and output schema errors after it remain outside this hook.
4. Only the two-argument overload is runtime-proven by this exact sample.

Production code, the Stage 09 sample source, and `.dd-apm-pipeline/PROGRESS.md` were not modified by this worker.
