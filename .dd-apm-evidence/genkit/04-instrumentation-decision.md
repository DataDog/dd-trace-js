# Stage 04: instrumentation analysis for `genkit@1.21.0`

Date: 2026-07-13 UTC

## Decision

- APM classification: **generative AI + workflow orchestration**. Model, embedder, and retriever actions are client-like
  request/response boundaries; flows, flow steps, and tools are internal orchestration boundaries.
- LLMObs classification: **`LlmObsCategory.ORCHESTRATION` (high confidence)**. Genkit coordinates registered model,
  tool, retrieval, embedding, and flow actions. It does not implement direct HTTP calls to LLM provider endpoints.
  The package's other fetches are for media download, its beta Genkit client, and telemetry export.
- Selected runtime boundary: `@genkit-ai/core@1.21.0` `runInNewSpan`, filtered by Genkit labels and metadata.
- Selected LLMObs kinds: `llm`, `workflow`, `tool`, `retrieval`, and `embedding`.
- Not selected: `agent`. Genkit generation can run tool loops, but 1.21.0 exposes no explicit agent execution API and
  its `generateHelper` recursively creates one `util` span per turn. Calling every generate operation an agent would
  be misleading and would duplicate nested turns.

The machine-readable target list is in `04-target-selection.json`.

## Required category-reference discrepancy

Stage 04 names `references/instrumentation/categories/generative-ai.md` and
`references/instrumentation/categories/orchestration.md` as mandatory inputs. The supplied workflow bundle contains
no `references/instrumentation/categories` directory or category files. This was confirmed with:

```sh
find .agents/skills/apm-integrations/references -path '*/instrumentation/categories/*' -type f -print
```

The analysis therefore used the repository `apm-integrations` and `llmobs-integration` skills and their relevant
Orchestrion, category-detection, and plugin-architecture references. This absence is evidence, not a passed
capability claim.

## Exact package and call path

The installed manifests resolve the relevant packages exactly:

```text
genkit                         1.21.0
@genkit-ai/ai                  1.21.0
@genkit-ai/core                1.21.0
```

The real call paths are:

```text
Genkit.generate / prompt / chat
  -> @genkit-ai/ai generate()
  -> generateHelper()
  -> registered ModelAction(...)
  -> Action.run(...)
  -> @genkit-ai/core runInNewSpan(... labels subtype=model ...)

Genkit.generateStream / prompt.stream / Chat.sendStream
  -> channel + response Promise
  -> same generate() / ModelAction / runInNewSpan path

defined Flow / ai.run step / defined Tool / RetrieverAction / EmbedderAction
  -> Action.run(...)
  -> same runInNewSpan boundary with subtype=flow|tool|retriever|embedder
     or genkit:type=flowStep
```

`actionFn.run` is the point where action input is schema-validated, the user/provider runner is awaited, output is
validated, and errors are rethrown. It delegates span lifecycle to `runInNewSpan`. At that shared boundary Genkit
passes a mutable `opts.metadata` object; during the awaited callback it adds `input`, serialized `output`, `state`,
and `path`. This gives the plugin final data without wrapping registration factories or dynamic returned functions.

Source evidence:

| Concern | Published source | Runtime CJS / ESM |
|---|---|---|
| shared lifecycle and overload | `@genkit-ai/core/src/tracing/instrumentation.ts:60-153` | `lib/tracing/instrumentation.js:41`, `lib/tracing/instrumentation.mjs:14` |
| action subtype, input/output, await, error | `@genkit-ai/core/src/action.ts:298-389` | `lib/action.js:77-163`, `lib/action.mjs:46-132` |
| flow subtype and user callback invocation | `@genkit-ai/core/src/flow.ts:91-150` | `lib/flow.js`, `lib/flow.mjs` |
| flow-step labels | `@genkit-ai/core/src/flow.ts:153-194` | `lib/flow.js`, `lib/flow.mjs` |
| generation and streaming funnel | `@genkit-ai/ai/src/generate.ts:374-414,628-655` | `lib/generate.js:182,357`, `lib/generate.mjs:172,347` |
| per-turn model and tool loop | `@genkit-ai/ai/src/generate/action.ts:112-424` | `lib/generate/action.js:62-`, `lib/generate/action.mjs:60-` |
| tool invocation | `@genkit-ai/ai/src/tool.ts:281-307` | `lib/tool.js:106`, `lib/tool.mjs:78` |
| retrieval action | `@genkit-ai/ai/src/retriever.ts:123-180` | `lib/retriever.js:71`, `lib/retriever.mjs:38` |
| embedding action | `@genkit-ai/ai/src/embedder.ts:113-190` | `lib/embedder.js:83`, `lib/embedder.mjs:57` |
| message/usage shapes | `@genkit-ai/ai/src/model-types.ts:55-74,267-344` | published declarations and model runtime |

## Hook lifecycle and Orchestrion feasibility

Use two Orchestrion `Async` entries with `functionName: 'runInNewSpan'` and a common channel:

```text
@genkit-ai/core  lib/tracing/instrumentation.js   CommonJS  line 41
@genkit-ai/core  lib/tracing/instrumentation.mjs  ESM       line 14
```

This is statically feasible: both published runtime files contain a named async function declaration, which is a
native Orchestrion target. It avoids shimmer, runtime-created method interception, argument mutation, and factory
return wrapping.

Lifecycle extraction:

1. `start`: resolve `opts` as `arguments.length === 3 ? arguments[1] : arguments[0]`; inspect `opts.labels`.
2. Strictly allow model, flow, flowStep, tool, retriever, and embedder. Ignore all other Genkit internal spans.
3. The APM tracing plugin starts `genkit.request`, `genkit.workflow`, or `genkit.tool` and returns its store so nested
   Genkit operations inherit the parent.
4. The LLMObs plugin registers the same APM span with its conditional LLMObs kind.
5. The wrapped promise runs. Genkit mutates `opts.metadata.input/output/state/path`; nested calls execute under the
   start store.
6. `asyncEnd`: prefer `ctx.result`, fall back to parsing `opts.metadata.output`, extract I/O, metadata, and metrics,
   then finish the APM span.
7. `error`: record `ctx.error`; LLMObs tags retain input and use an empty output shape.
8. `end`: restore the LLMObs parent context.

## LLMObs field decisions

### Model/generation (`llm`)

- Name: registered action name from `opts.metadata.name`.
- Provider candidate: prefix before `/` in the action name, when present. Do not invent a provider for unqualified
  custom model names.
- Model name: full registered action name initially; fixtures may justify splitting provider and model components.
- Inputs: `opts.metadata.input.messages`; map Genkit role `model` to LLMObs `assistant`.
- Outputs: `ctx.result.message` (or parsed metadata output). Genkit 1.21.0 returns one primary message; deprecated
  `candidates` is a fallback only.
- Metrics: map `usage.inputTokens`, `usage.outputTokens`, `usage.totalTokens` to
  `input_tokens`, `output_tokens`, `total_tokens`. Preserve `thoughtsTokens` and `cachedContentTokens` as additional
  metrics only if supported by the tagger contract.
- Metadata candidates: request `config` values such as version, temperature, max output tokens, top-k/top-p, stop
  sequences, finish reason, and latency. Avoid secrets and raw provider responses.
- Tool calls: preserve `toolRequest` and `toolResponse` parts structurally when the LLMObs message schema supports
  them; flatten ordinary text parts and safely summarize media/data parts.

### Workflow and tool (`workflow`, `tool`)

- Name: `opts.metadata.name`.
- Input/output: `tagTextIO` with the original structured value, subject to normal LLMObs serialization/redaction.
- A flow action is the parent of operations invoked by its user function. A named `ai.run` step is another workflow
  child because its native label is `genkit:type=flowStep`.
- A tool action covers direct execution and automatic model-selected execution. `defineTool` is only registration.

### Retrieval (`retrieval`)

- Input document: `opts.metadata.input.query`, whose shape is `{ content: Part[], metadata? }`.
- Output documents: `ctx.result.documents`.
- Name: registered retriever action name. Options are metadata, not retrieval document content.

### Embedding (`embedding`)

- Inputs: `opts.metadata.input.input`, an array of documents. This naturally batches `embedMany` in one span.
- Outputs: `ctx.result.embeddings`. Do not emit the full numeric vectors as ordinary APM tags; LLMObs embedding
  output should follow existing tagger size/redaction behavior.
- Name: registered embedder action name; derive provider only when the registered name proves one.

## Streaming completion

`generateStream` is not an async iterator operation boundary. It synchronously returns `{ response, stream }`, while
the underlying `generated` promise calls the same `generate` path and closes/errors the channel when that promise
settles. The provider ModelAction itself returns a promise and does not resolve until its final response exists.

Therefore the selected Orchestrion kind is `Async`, not `AsyncIterator`. The LLM span includes all provider work and
chunk production, and finishes on final response or error. It does **not** remain open while application code delays
or abandons draining the channel. That is the desired model-operation duration; consumer-drain timing is a known
limitation and should not be presented as provider latency.

## Duplicate and skipped surfaces

- Skip `Genkit.generate`, prompt callables, and chat `send`: they converge on the selected model action and would
  duplicate it while missing other invocation routes.
- Skip all `*Stream` container-return methods: their synchronous duration is incorrect.
- Skip `generateHelper` as an LLMObs span: recursive tool turns would make nested duplicate generation spans.
- Skip `resolveToolRequest`: it invokes the already traced ToolAction and includes prompt-transfer bookkeeping.
- Skip registration/factory functions (`defineFlow`, `defineTool`, `defineRetriever`, `defineEmbedder`, `defineModel`).
- Skip unrelated `runInNewSpan` labels (`util`, prompt rendering, evaluator, indexer, reranker, resource, tests).
- No agent kind is emitted until a real explicit Genkit agent lifecycle is found.

Provider SDK integrations may also be active beneath a Genkit model action. Following the LangChain precedent, the
implementation/review stages must decide whether a Genkit model span is demoted to `workflow` when a supported
provider LLMObs plugin already emits the single authoritative `llm` span. The real sample must prove there is no
token/cost double counting.

## Known limitations and validation obligations

1. Genkit starts a native OpenTelemetry span inside `runInNewSpan`. Depending on Datadog OTel bridge configuration,
   the new tracing span can coexist with a near-duplicate native Genkit APM span. The real-app evidence gate must
   inspect captured JSON and resolve or document this; unit tests cannot waive it.
2. Provider is conventionally encoded in registered action names, not a guaranteed dedicated model-action field.
3. Streaming completion covers producer completion, not downstream stream-drain duration.
4. Tool interrupts are caught as control flow by `resolveToolRequest`; fixtures must pin whether their ToolAction span
   is error or interrupted-success before final tagging.
5. Media, custom parts, raw provider responses, and embedding vectors need bounded serialization and redaction.
6. The target supports the exact installed `@genkit-ai/core@1.21.0`; a future version range requires source-diff
   evidence across its declared endpoints.

## Reproduction commands

Run from `/workspace/repo`:

```sh
node -e "const fs=require('node:fs'); for (const name of ['genkit','@genkit-ai/ai','@genkit-ai/core']) { const manifest='/tmp/dd-apm-genkit-1.21.0/node_modules/'+name+'/package.json'; const pkg=JSON.parse(fs.readFileSync(manifest)); console.log(pkg.name+'@'+pkg.version) }"
rg -n "function runInNewSpan|actionFn.run =" /tmp/dd-apm-genkit-1.21.0/node_modules/@genkit-ai/core/{src,lib}
rg -n "function generateStream|async function generate|function defineFlow|function defineTool|function defineRetriever|function defineEmbedder" /tmp/dd-apm-genkit-1.21.0/node_modules/{genkit,@genkit-ai/ai,@genkit-ai/core}/{src,lib}
rg -n "node-fetch|fetch\\(|https?\\.request|axios|undici" /tmp/dd-apm-genkit-1.21.0/node_modules/{genkit,@genkit-ai/ai,@genkit-ai/core}/src
node -e "JSON.parse(require('node:fs').readFileSync('.dd-apm-evidence/genkit/04-target-selection.json')); console.log('valid JSON')"
```

## Stage validation

Validation performed:

```text
JSON parse: passed
target package: genkit@1.21.0
hook package: @genkit-ai/core@1.21.0
CJS target exists: lib/tracing/instrumentation.js:41
ESM target exists: lib/tracing/instrumentation.mjs:14
selected function is async in both builds: yes
production code modified: no
PROGRESS.md modified: no
```
