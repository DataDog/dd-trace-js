# LLMObsPlugin Architecture Reference

Guide to implementing LLMObs plugins in dd-trace-js.

## Base Class

All LLMObs plugins extend `LLMObsPlugin` at `packages/dd-trace/src/llmobs/plugins/base.js`.

The base class handles span registration, context management, and lifecycle hooks. Plugins only need to implement two
methods.

## Required Methods

### getLLMObsSpanRegisterOptions(ctx)

Defines span metadata for registration with LLMObs. Called at span start.

**Returns** an object with:
- `kind` (string) — span type, from `SPAN_KINDS`: `'llm'`, `'agent'`, `'workflow'`, `'task'`, `'tool'`, `'embedding'`,
  `'retrieval'`
- `name` (string) — operation name (e.g. `'openai.chat.completions'`)
- `modelProvider` (string, optional) — provider name (e.g. `'openai'`, `'anthropic'`, `'google'`)
- `modelName` (string, optional) — model identifier (e.g. `'gpt-4'`, `'claude-3-sonnet'`)

**Return nothing** to skip recording an LLMObs span for a given `ctx` entirely — `base.js` only tests the
result for truthiness, and the plugins use a bare `return` (`openai/index.js` does this for the methods it
does not trace).

### setLLMObsTags(ctx)

Extracts and tags LLM-specific data after the operation completes. Called in `asyncEnd`.

Responsibilities:
1. Extract input messages/data from `ctx.arguments`
2. Extract output messages/data from `ctx.result`
3. Extract token usage metrics
4. Extract model parameters (metadata)
5. Tag all data via `this._tagger` methods (see below)

Always tag inputs. On error, tag empty outputs. On success, tag outputs, metrics, and metadata.

## Plugin Lifecycle

1. `start(ctx)` — registers the LLMObs span, captures parent context
2. Operation executes
3. `asyncEnd(ctx)` — calls `setLLMObsTags()` to extract and tag data
4. `end(ctx)` — restores parent context

## Tagger Methods

Tag data using `this._tagger`, which provides:

- `tagLLMIO(span, inputMessages, outputMessages)` — for `llm` spans
- `tagEmbeddingIO(span, inputDocuments, outputDocuments)` — for `embedding` spans
- `tagRetrievalIO(span, inputDocuments, outputDocuments)` — for `retrieval` spans
- `tagTextIO(span, inputValue, outputValue)` — for `workflow`, `agent`, `tool` spans
- `tagMetadata(span, metadata)` — model parameters (temperature, max_tokens, etc.)
- `tagMetrics(span, metrics)` — token usage (`input_tokens`, `output_tokens`, `total_tokens`)
- `tagSpanTags(span, tags)` — arbitrary key/value span tags
- `tagPrompt(span, prompt)` — prompt tracking metadata
- `tagToolDefinitions(span, toolDefinitions)` — the tools a request declared, for tool-calling integrations
- `tagModelName(span, modelName)` — a model name discovered after registration

## Static Properties

Each plugin class needs:
- `static integration` — integration name for LLMObs telemetry (`'openai'`, `'google_genai'`)
- `static id` — unique plugin ID. Often the same string as the integration (`'openai'`), but not
  necessarily: genai pairs `id = 'google-genai'` with `integration = 'google_genai'`. A package that hooks
  several operations qualifies it per operation (`'llmobs_langgraph_pregel_stream'`)
- `static prefix` — diagnostic channel prefix (e.g. `'tracing:apm:openai:request'`)

## Error Handling

Always tag empty outputs on error to ensure consistent span structure:

```javascript
if (ctx.error) {
  this._tagger.tagLLMIO(span, inputMessages, [{ content: '', role: '' }])
  return
}
```

## Reference Implementations

See existing plugins for complete working examples:
- `packages/dd-trace/src/llmobs/plugins/openai/index.js` — simple messages array, standard token usage
- `packages/dd-trace/src/llmobs/plugins/anthropic/util.js` — nested content arrays, different token field names
- `packages/dd-trace/src/llmobs/plugins/genai/util.js` — contents/parts format, role normalization
- `packages/dd-trace/src/llmobs/plugins/langgraph/index.js` — orchestration, `workflow` span kind, no messages
