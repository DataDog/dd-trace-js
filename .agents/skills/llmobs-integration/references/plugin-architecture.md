# LLMObsPlugin Architecture Reference

Guide to implementing LLMObs plugins in dd-trace-js.

## Base Class

All LLMObs plugins extend `LLMObsPlugin`, located at `packages/dd-trace/src/llmobs/plugins/base.js`.

A plugin is a class with static configuration properties (`integration`, `id`, `prefix`) and two required methods, exported as an array.

## Required Methods

### getLLMObsSpanRegisterOptions(ctx)

Called at span start to define span metadata for registration with LLMObs. Returns an object with:
- `modelProvider` — provider name (e.g., `'openai'`, `'anthropic'`, `'google'`)
- `modelName` — model identifier extracted from span tags or request params
- `kind` — span kind: `'llm'` for chat completions, `'embedding'` for embeddings, `'workflow'` for orchestration, etc.
- `name` — operation name (e.g., `'openai.chat.completions'`)

Model name and provider are typically available via `ctx.currentStore?.span?.context()._tags`.

### setLLMObsTags(ctx)

Called after the operation completes (`asyncEnd`). Extracts LLM-specific data and tags the span:
1. Extract input messages from `ctx.arguments?.[0]` and call `this.tagInputMessages(span, messages)`
2. On error (`ctx.error`): call `this.tagOutputMessages(span, [{ content: '', role: '' }])` and return
3. On success: extract output messages, token metrics, and metadata from `ctx.result`, then tag each

## Inherited Tagging Methods

These are provided by the base class and should be called from `setLLMObsTags`:

- `tagInputMessages(span, messages)` — tags input messages; expects `[{content, role}]`
- `tagOutputMessages(span, messages)` — tags output messages; expects `[{content, role}]`
- `tagMetrics(span, metrics)` — tags token usage; expects `{input_tokens, output_tokens, total_tokens}`
- `tagMetadata(span, metadata)` — tags model parameters; expects `{temperature, max_tokens, ...}`

## Plugin Lifecycle

1. `start(ctx)` — registers span with LLMObs, captures parent context
2. Operation executes
3. `asyncEnd(ctx)` — calls `setLLMObsTags()` to extract and tag all LLM data
4. `end(ctx)` — restores parent context

## Reference Implementations

See existing plugins for complete working examples:
- [`packages/dd-trace/src/llmobs/plugins/openai/index.js`](../../../../../packages/dd-trace/src/llmobs/plugins/openai/index.js)
- [`packages/datadog-plugin-anthropic/src/llmobs.js`](../../../../../packages/datadog-plugin-anthropic/src/llmobs.js)
- [`packages/datadog-plugin-google-genai/src/llmobs.js`](../../../../../packages/datadog-plugin-google-genai/src/llmobs.js)
