# LLMObsPlugin Architecture Reference

Guide to implementing LLMObs plugins in dd-trace-js.

## Base Class

All LLMObs plugins extend `LLMObsPlugin` at `packages/dd-trace/src/llmobs/plugins/base.js`.

The base class handles span registration, context management, and lifecycle hooks. Plugins only need to implement two methods.

## Required Methods

### getLLMObsSpanRegisterOptions(ctx)

Defines span metadata for registration with LLMObs. Called at span start.

**Returns** an object with:
- `kind` (string) — span type: `'llm'`, `'embedding'`, `'workflow'`, `'agent'`, `'tool'`, `'retrieval'`
- `name` (string) — operation name (e.g. `'openai.chat.completions'`)
- `modelProvider` (string, optional) — provider name (e.g. `'openai'`, `'anthropic'`, `'google'`)
- `modelName` (string, optional) — model identifier (e.g. `'gpt-4'`, `'claude-3-sonnet'`)

**Return `null`** to skip recording an LLMObs span for a given `ctx` entirely.

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

## Static Properties

Each plugin class needs:
- `static integration` — integration name (e.g. `'openai'`)
- `static id` — unique plugin ID (e.g. `'llmobs_openai'`)
- `static prefix` — diagnostic channel prefix (e.g. `'tracing:apm:openai:chat'`)

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
- `packages/datadog-plugin-anthropic/src/llmobs.js` — nested content arrays, different token field names
- `packages/datadog-plugin-google-genai/src/llmobs.js` — contents/parts format, role normalization
- `packages/dd-trace/src/llmobs/plugins/langgraph/index.js` — orchestration, `workflow` span kind, no messages
