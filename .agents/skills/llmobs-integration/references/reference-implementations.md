# Reference Plugin Implementations

Working examples of LLMObs plugins in dd-trace-js.

## Base Plugin

**Location:** `packages/dd-trace/src/llmobs/plugins/base.js`

The abstract base class leaf plugins extend. Composite roots such as `ai/index.js` extend `CompositePlugin`
instead.

**Key methods:**
- `start(ctx)` - Registers span, captures context
- `getLLMObsSpanRegisterOptions(ctx)` - Abstract, must implement
- `setLLMObsTags(ctx)` - Abstract, must implement
- `end(ctx)` - Restores context after the wrapped call returns
- `asyncEnd(ctx)` - Calls setLLMObsTags after the operation settles

**Tagger methods** (accessed via `this._tagger`):
- `tagLLMIO`, `tagEmbeddingIO`, `tagRetrievalIO`, `tagTextIO`
- `tagMetadata`, `tagMetrics`, `tagSpanTags`, `tagPrompt`, `tagToolDefinitions`, `tagModelName`

## Simple LLM Client Examples

### OpenAI Plugin

**Location:** `packages/dd-trace/src/llmobs/plugins/openai/index.js`

**Category:** LLM API Client

**Characteristics:**
- Simple message array format (`messages: [{role, content}]`)
- Straightforward token usage extraction (`usage.prompt_tokens`, `usage.completion_tokens`)
- Standard response format (`choices[0].message`)

**Good for:** Learning basic plugin structure

### Anthropic Plugin

**Location:** `packages/dd-trace/src/llmobs/plugins/anthropic/` (`index.js` + `util.js`)

**Category:** LLM API Client

**Characteristics:**
- Nested content format (`content: [{type: 'text', text: '...'}]`)
- Different token field names (`usage.input_tokens`, `usage.output_tokens`)
- Requires content array flattening

**Good for:** Handling non-standard message formats

### Google GenAI Plugin

**Location:** `packages/dd-trace/src/llmobs/plugins/genai/` (`index.js` + `util.js`)

**Category:** LLM API Client

**Characteristics:**
- Contents/parts format (`contents: [{role, parts: [{text}]}]`)
- Candidates array (`candidates[0].content.parts`)
- Role normalization ('model' → 'assistant')

**Good for:** Complex nested structures, role normalization

## Multi-Provider Examples

### Vercel AI SDK

**Location:** `packages/dd-trace/src/llmobs/plugins/ai/` (`ddTelemetry.js` + `vercelTelemetry.js` behind a
`CompositePlugin`)

**Category:** Multi-Provider Framework

**Characteristics:**
- Wraps multiple providers (OpenAI, Anthropic, etc.)
- Unified interface across providers
- Provider detection logic

**Good for:** Provider abstraction patterns

## Orchestration Examples

### LangGraph

**Location:** `packages/dd-trace/src/llmobs/plugins/langgraph/`

**Category:** Pure Orchestration

**Characteristics:**
- Workflow/graph execution methods (`invoke`, `stream`)
- State management tracking
- Uses 'workflow' span kind instead of 'llm'
- No direct LLM API calls

LangChain is a separate hybrid plugin (`packages/dd-trace/src/llmobs/plugins/langchain/`). It emits `workflow`,
`llm`, `embedding`, `tool`, and `retrieval` spans. Provider-backed cases run over the VCR proxy.

**Good for:** Workflow instrumentation, non-LLM span kinds

## Comparison Table

| Plugin | Category | Format Complexity | Special Features |
|--------|----------|-------------------|------------------|
| OpenAI | LLM Client | Simple | Standard reference |
| Anthropic | LLM Client | Medium | Nested content arrays |
| Google GenAI | LLM Client | Complex | Multi-level nesting, role normalization |
| Vercel AI SDK | Multi-Provider | Medium | Provider abstraction |
| LangGraph | Orchestration | Simple | Workflow spans, state management |

Per-provider request, response and token-field shapes live in
[message-extraction.md](message-extraction.md).

## Streaming Implementations

### OpenAI Streaming

**Pattern:** Accumulate deltas from `chunk.choices[0].delta.content`

### Anthropic Streaming

**Pattern:** Accumulate from `chunk.delta.text` or `chunk.content_block.text`

### General Streaming Approach

Use the contract the instrumentation already publishes. Anthropic and GenAI append chunks to the operation's `ctx`
and build `ctx.result` when the chunk channel reports `done`; OpenAI's instrumentation builds the result before
publishing `asyncEnd`. The plugin tags that final result instead of maintaining a second request-keyed buffer.

## CompositePlugin Integration

Some plugins integrate LLMObs with tracing plugins using `CompositePlugin`. The plugin class exposes a
`static plugins` mapping, either as a field or a getter.

See `packages/datadog-plugin-google-genai/src/index.js` for a reference implementation.

## Testing Examples

Test files demonstrate expected span structure and assertions:

**Locations:**
- `packages/dd-trace/test/llmobs/plugins/openai/openaiv4.spec.js`
- `packages/dd-trace/test/llmobs/plugins/anthropic/index.spec.js`
- `packages/dd-trace/test/llmobs/plugins/google-genai/index.spec.js`
- `packages/dd-trace/test/llmobs/plugins/langgraph/index.spec.js`

Start from `base.js` for the abstract methods, then the plugin above whose message format is closest to the
one you are adding.
