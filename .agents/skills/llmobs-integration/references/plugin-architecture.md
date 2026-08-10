# LLMObsPlugin Architecture Reference

Guide to implementing LLMObs plugins in dd-trace-js.

## Base Class

Leaf plugins extend `LLMObsPlugin` at `packages/dd-trace/src/llmobs/plugins/base.js`. A composite root can extend
`CompositePlugin` and select among leaf implementations, as `ai/index.js` does.

The LLMObs base class handles span registration, context management, and lifecycle hooks. Leaf plugins implement two
methods.

## Required Methods

### getLLMObsSpanRegisterOptions(ctx)

Defines span metadata for registration with LLMObs. Called at span start.

**Returns** an object with:
- `kind` (string) — span type. `SPAN_KINDS` lists `'llm'`, `'agent'`, `'workflow'`, `'task'`, `'tool'`, `'embedding'`,
  and `'retrieval'`; plugin extensions such as `'step'` also exist
- `name` (string, optional) — operation name (e.g. `'openai.chat.completions'`); the event falls back to the APM
  span name when omitted
- `modelProvider` (string, optional) — provider name (e.g. `'openai'`, `'anthropic'`, `'google'`)
- `modelName` (string, optional) — model identifier (e.g. `'gpt-4'`, `'claude-3-sonnet'`)
- `sessionId` (string, optional) — session identifier when the integration supplies one

**Return nothing** to skip recording an LLMObs span for a given `ctx` entirely — `base.js` only tests the
result for truthiness, and the plugins use a bare `return` (`openai/index.js` does this for the methods it
does not trace).

### setLLMObsTags(ctx)

Extracts and tags LLM-specific data after the operation completes. Called in `asyncEnd`.

Responsibilities:
1. Extract the kind-specific input from the channel's `ctx` fields
2. Extract the kind-specific output from the channel's `ctx` fields
3. Extract token usage metrics when available
4. Extract model parameters when available
5. Tag all data via `this._tagger` methods (see below)

Tag the input when the channel provides it. Error output is integration-specific: OpenAI and GenAI use an empty
message, while integrations without a result omit output. Pin that contract in the integration's spec.

## Plugin Lifecycle

1. `start(ctx)` — registers the LLMObs span and captures parent context
2. The wrapped operation is invoked
3. `end(ctx)` — restores parent context after the wrapped call returns
4. `asyncEnd(ctx)` — calls `setLLMObsTags()` after a promise-backed operation settles

## Tagger Methods

Tag data using `this._tagger`, which provides:

- `tagLLMIO(span, inputMessages, outputMessages)` — for `llm` spans
- `tagEmbeddingIO(span, inputDocuments, outputValue)` — for `embedding` spans
- `tagRetrievalIO(span, inputValue, outputDocuments)` — for `retrieval` spans
- `tagTextIO(span, inputValue, outputValue)` — for `workflow`, `agent`, `task`, `step`, and `tool` spans
- `tagMetadata(span, metadata)` — model parameters (temperature, max_tokens, etc.)
- `tagMetrics(span, metrics)` — token usage (`input_tokens`, `output_tokens`, `total_tokens`)
- `tagSpanTags(span, tags)` — arbitrary key/value span tags
- `tagPrompt(span, prompt, strictValidation = false)` — prompt tracking metadata
- `tagToolDefinitions(span, toolDefinitions)` — the tools a request declared, for tool-calling integrations
- `tagModelName(span, modelName)` — a model name discovered after registration

## Static Properties

Each leaf plugin class needs:
- `static integration` — integration name for LLMObs telemetry (`'openai'`, `'google_genai'`)
- `static id` — unique plugin ID. Often the same string as the integration (`'openai'`), but not
  necessarily: genai pairs `id = 'google-genai'` with `integration = 'google_genai'`. A package that hooks
  several operations qualifies it per operation (`'llmobs_langgraph_pregel_stream'`)
- `static prefix` — diagnostic channel prefix (e.g. `'tracing:apm:openai:request'`)

## Error Handling

OpenAI and GenAI tag an empty output message on error:

```javascript
if (ctx.error) {
  this._tagger.tagLLMIO(span, inputMessages, [{ content: '' }])
  return
}
```

That is not a base-class invariant. Anthropic omits output when no result exists, and non-`llm` integrations follow
their own kind-specific contract.

## Reference Implementations

See existing plugins for complete working examples:
- `packages/dd-trace/src/llmobs/plugins/openai/index.js` — simple messages array, standard token usage
- `packages/dd-trace/src/llmobs/plugins/anthropic/` — nested content in `util.js`, usage extraction in `index.js`
- `packages/dd-trace/src/llmobs/plugins/genai/util.js` — contents/parts format, role normalization
- `packages/dd-trace/src/llmobs/plugins/langgraph/index.js` — orchestration, `workflow` span kind, no messages
