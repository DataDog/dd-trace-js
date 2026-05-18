# Reference Plugin Implementations

Working examples of LLMObs plugins in dd-trace-js.

## Base Plugin

**Location:** `packages/dd-trace/src/llmobs/plugins/base.js`

The abstract base class all plugins extend.

**Key methods:**
- `start(ctx)` - Registers span, captures context
- `getLLMObsSpanRegisterOptions(ctx)` - Abstract, must implement
- `setLLMObsTags(ctx)` - Abstract, must implement
- `asyncEnd(ctx)` - Calls setLLMObsTags
- `end(ctx)` - Restores context

**Tagger methods** (accessed via `this._tagger`):
- `tagLLMIO`, `tagEmbeddingIO`, `tagRetrievalIO`, `tagTextIO`
- `tagMetadata`, `tagMetrics`, `tagSpanTags`, `tagPrompt`

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

**Location:** `packages/datadog-plugin-anthropic/src/llmobs.js`

**Category:** LLM API Client

**Characteristics:**
- Nested content format (`content: [{type: 'text', text: '...'}]`)
- Different token field names (`usage.input_tokens`, `usage.output_tokens`)
- Requires content array flattening

**Good for:** Handling non-standard message formats

### Google GenAI Plugin

**Location:** `packages/datadog-plugin-google-genai/src/llmobs.js`

**Category:** LLM API Client

**Characteristics:**
- Contents/parts format (`contents: [{role, parts: [{text}]}]`)
- Candidates array (`candidates[0].content.parts`)
- Role normalization ('model' → 'assistant')

**Good for:** Complex nested structures, role normalization

## Multi-Provider Examples

### Vercel AI SDK

**Location:** `packages/datadog-plugin-ai-sdk/src/llmobs.js`

**Category:** Multi-Provider Framework

**Characteristics:**
- Wraps multiple providers (OpenAI, Anthropic, etc.)
- Unified interface across providers
- Provider detection logic

**Good for:** Provider abstraction patterns

## Orchestration Examples

### LangChain LangGraph

**Location:** `packages/datadog-plugin-langchain-langgraph/src/llmobs.js`

**Category:** Pure Orchestration

**Characteristics:**
- Workflow/graph execution methods (`invoke`, `stream`)
- State management tracking
- Uses 'workflow' span kind instead of 'llm'
- No direct LLM API calls

**Good for:** Workflow instrumentation, non-LLM span kinds

## Comparison Table

| Plugin | Category | Format Complexity | Special Features |
|--------|----------|-------------------|------------------|
| OpenAI | LLM Client | Simple | Standard reference |
| Anthropic | LLM Client | Medium | Nested content arrays |
| Google GenAI | LLM Client | Complex | Multi-level nesting, role normalization |
| Vercel AI SDK | Multi-Provider | Medium | Provider abstraction |
| LangGraph | Orchestration | Simple | Workflow spans, state management |

## Key Patterns by Provider

### OpenAI Pattern
```javascript
// Messages: Simple array
inputs.messages → [{role, content}]

// Response: choices array
results.choices[0].message → {role, content}

// Tokens: Standard names
usage.prompt_tokens, usage.completion_tokens
```

### Anthropic Pattern
```javascript
// Messages: Content blocks
msg.content[0].text → Extract text from blocks

// Response: Content array
results.content.filter(c => c.type === 'text')

// Tokens: Different names
usage.input_tokens, usage.output_tokens
```

### Google Pattern
```javascript
// Messages: Parts format
contents → [{role, parts: [{text}]}]

// Response: Candidates
candidates[0].content.parts → Join text

// Tokens: Mixed names
usageMetadata.promptTokenCount, candidatesTokenCount
```

### LangGraph Pattern
```javascript
// Input: State objects
StateGraph state → Extract relevant fields

// Output: State changes
Track state transitions, not LLM responses

// Span kind: 'workflow' not 'llm'
kind: 'workflow' for graph execution
```

## Streaming Implementations

### OpenAI Streaming

**Pattern:** Accumulate deltas from `chunk.choices[0].delta.content`

### Anthropic Streaming

**Pattern:** Accumulate from `chunk.delta.text` or `chunk.content_block.text`

### General Streaming Approach

1. Maintain buffer keyed by request/span ID
2. On each chunk, extract delta and append to buffer
3. On completion, tag accumulated content
4. Clear buffer for that request

## CompositePlugin Integration

Some plugins integrate LLMObs with tracing plugins using `CompositePlugin`. The plugin class declares a `static plugins` field mapping keys to plugin classes.

See `packages/datadog-plugin-google-genai/src/index.js` for a reference implementation.

## Testing Examples

Test files demonstrate expected span structure and assertions:

**Locations:**
- `packages/dd-trace/test/llmobs/plugins/openai/index.spec.js`
- `packages/dd-trace/test/llmobs/plugins/anthropic/index.spec.js`
- `packages/dd-trace/test/llmobs/plugins/google-genai/index.spec.js`
- `packages/dd-trace/test/llmobs/plugins/langchain-langgraph/index.spec.js`

## How to Use References

### Starting Point

1. Read `base.js` to understand abstract methods
2. Study OpenAI plugin for simplest example
3. Look at Anthropic/Google for complex formats

### Finding Similar Patterns

1. Check message format in provider docs
2. Find reference plugin with similar format
3. Adapt extraction logic

### Debugging

1. Compare your plugin with reference
2. Check test files for expected structure
3. Verify message format matches standard

## Quick Reference Guide

**Simple formats (messages array):** Use OpenAI pattern

**Nested content:** Use Anthropic pattern

**Multi-level nesting:** Use Google pattern

**Multiple providers:** Use Vercel AI SDK pattern

**Orchestration/workflows:** Use LangGraph pattern

**Streaming:** Check OpenAI streaming implementation

**CompositePlugin:** Check Anthropic integration
