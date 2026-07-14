# Stage 19: build Genkit LLMObs integration

Date: 2026-07-14 UTC

## Result

The first-class Genkit LLMObs layer is implemented on the existing exact-version
`tracing:orchestrion:@genkit-ai/core:runInNewSpan` channel. It registers LLMObs annotations on the APM span created
by the Genkit tracing plugin and supports `llm`, `workflow`, `tool`, `retrieval`, and `embedding`. It does not emit
an `agent` kind because Genkit 1.21.0 has no explicit agent lifecycle.

The integration is classified as **`LlmObsCategory.ORCHESTRATION` with high confidence**. Exact 1.21.0 source shows
that Genkit coordinates registered action runners and workflows through `@genkit-ai/core` `runInNewSpan`; it does
not implement direct provider HTTP requests. Model actions remain useful `llm` spans for custom or otherwise
uninstrumented models, while flows and named flow steps are `workflow` spans.

The category-specific path named by the Stage 19 template,
`references/llmobs_instrumentation/categories/orchestration.md`, is not present in the supplied workflow bundle or
repository. The available `llmobs-integration` category-detection, plugin-architecture, message-extraction, and
reference-implementation guidance was applied. This missing reference is not represented as a passed capability.

## Files

- Created `packages/dd-trace/src/llmobs/plugins/genkit/index.js` with the Genkit LLMObs plugin and normalization
  helpers.
- Created `packages/datadog-plugin-genkit/src/tracing.js` by moving the existing tracing implementation unchanged
  behind a dedicated module boundary.
- Changed `packages/datadog-plugin-genkit/src/index.js` to compose LLMObs first and tracing second, following the
  established repository lifecycle order. The tracing `bindStart` store binding still creates the APM span before
  the LLMObs `start` subscriber runs, and LLMObs enrichment occurs before tracing finishes the span.

The LLMObs member has id `llmobs_genkit`, integration `genkit`, and the same channel prefix as the tracing member.
It overrides ignored-operation error/context behavior so an unselected native Genkit span cannot annotate or mark
an already-active selected parent span.

## Implemented mappings

The strict label allowlist and overload selection follow the Stage 11 runtime contract:

```text
arguments.length === 3 ? arguments[1] : arguments[0]
```

- `genkit:metadata:subtype=model` -> `llm`
- `genkit:metadata:subtype=flow` -> `workflow`
- `genkit:type=flowStep` -> `workflow`
- `genkit:metadata:subtype=tool` -> `tool`
- `genkit:metadata:subtype=retriever` -> `retrieval`
- `genkit:metadata:subtype=embedder` -> `embedding`

Unrecognized utility, prompt, evaluator, indexer, reranker, resource, and other native spans return no LLMObs
registration. Result extraction prefers `ctx.result` and safely parses `options.metadata.output` only as a fallback;
malformed fallback JSON is ignored without affecting the application.

### Model generation

- Genkit `Part[]` messages become valid LLMObs messages.
- Role `model` maps to `assistant`.
- Only text, `toolRequest`, and `toolResponse` parts are retained. Media, data, custom, reasoning, resource, raw,
  and arbitrary message metadata are excluded.
- Tool requests become `toolCalls` with name, object arguments, and optional tool id. Tool responses become
  `toolResults` with string output, name, and optional tool id.
- Only numeric `inputTokens`, `outputTokens`, and `totalTokens` are sent to `tagMetrics`.
- Metadata uses an explicit scalar allowlist: version, temperature, max output tokens, top-k, top-p, tool choice,
  finish reason, and latency.
- Errors use `[{ content: '', role: '' }]` as output.

The Stage 11 local model action name is not provider evidence, so model provider and model name are intentionally
left unset rather than inferred from the slash-separated action name.

### Workflow and tool

Structured input/output goes through LLMObs `tagTextIO` only; it is not added to ordinary APM tags. Errors use an
empty output. Stage 11 proved that a tool interrupt completes the tool hook with `ToolInterruptError` while the
enclosing generation completes successfully with `finishReason=interrupted`; the shared lifecycle preserves that
behavior without special-casing the error away.

### Retrieval

Only text parts are joined. Returned documents are converted to `{ text, name?, id?, score? }`; only reviewed scalar
metadata fields are copied. Arbitrary document metadata is excluded, and errors use an empty document list.

### Embedding

Input documents become `{ text, name?, id? }`. Numeric vectors and arbitrary embedding metadata are never passed to
the tagger. Successful output is summarized as `[N embedding(s) returned with size D]` when vectors share a common
dimension, otherwise as a bounded count-only summary. Errors use an empty output.

## Provider-owned LLM demotion

No provider demotion was implemented. The established LangChain precedent demotes only when both a trusted
provider tag maps to a supported integration and that integration's LLMObs plugin is enabled. Genkit's captured
`runInNewSpan` context has no trusted provider field, and its action-name namespace may be arbitrary. Guessing from
`local/offline-model` or another slash-separated name would misclassify custom actions. Duplicate provider/native
span behavior remains a live trace question.

## Architecture score

The baseline is the tracing-only single-module plugin; the proposal is the composite boundary with dedicated tracing
and LLMObs members:

| Dimension | Baseline -> proposal | Rationale |
| --- | --- | --- |
| Drift prevention | 5 -> 9 | One shared channel and one normalization implementation cover every kind. |
| Module coupling | 6 -> 9 | LLMObs uses the existing APM span contract through composition, without reaching into tracing internals. |
| Explicit contracts | 6 -> 9 | Strict labels, overload selection, kind mapping, and allowlists are centralized. |
| Testability at boundaries | 7 -> 9 | Tracing, normalization, registration, and composite lifecycle can be asserted independently. |
| Extensibility | 4 -> 9 | A new reviewed Genkit subtype is added to one operation map and one tagging branch. |
| Hot-path fitness | 9 -> 9 | Instrumentation is unchanged; LLMObs base gates enrichment when disabled. |

The proposal scores at least 8/10 in all six dimensions.

## Validation

No test suite was run because Stage 20 owns comprehensive tests. Stage 19 ran only syntax, targeted lint, static
composition assertions, and whitespace validation:

```sh
node --check packages/datadog-plugin-genkit/src/index.js
node --check packages/datadog-plugin-genkit/src/tracing.js
node --check packages/dd-trace/src/llmobs/plugins/genkit/index.js
npm exec -- eslint \
  packages/datadog-plugin-genkit/src/index.js \
  packages/datadog-plugin-genkit/src/tracing.js \
  packages/dd-trace/src/llmobs/plugins/genkit/index.js
git diff --check
```

All commands exited `0`; ESLint and `git diff --check` produced no output. A static assertion confirmed composite id
`genkit`, member order `llmobs` then `tracing`, LLMObs id `llmobs_genkit`, integration `genkit`, the shared prefix,
and both required LLMObs methods.

## Unresolved runtime questions

1. Supported-provider LLMObs duplication and token ownership require a reliable provider identity plus live trace
   evidence; action names alone are insufficient.
2. Native Genkit OpenTelemetry and Datadog APM near-duplicate behavior remains a final live observability question.
3. Stage 20 must pin success, error, streaming completion, tool interrupt, nesting, fallback parsing, redaction,
   vector omission, and emitted LLMObs event shapes.

No progress file was changed and no commit was created by this stage worker.
