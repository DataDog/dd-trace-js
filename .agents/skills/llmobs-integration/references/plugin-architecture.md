# LLMObsPlugin Architecture Reference

Complete guide to implementing LLMObs plugins in dd-trace-js.

## Base Class Structure

All LLMObs plugins extend the `LLMObsPlugin` base class located at `packages/dd-trace/src/llmobs/plugins/base.js`.

### Plugin Class Template

```javascript
'use strict'

const LLMObsPlugin = require('../base')

class ProviderLLMObsPlugin extends LLMObsPlugin {
  // Static configuration
  static integration = 'provider-name'  // Integration identifier
  static id = 'llmobs_provider_name'    // Unique plugin ID
  static prefix = 'tracing:apm:provider:operation'  // Diagnostic channel prefix

  // Required method 1: Define span registration options
  getLLMObsSpanRegisterOptions(ctx) {
    const span = ctx.currentStore?.span
    const tags = span?.context()._tags || {}

    return {
      modelProvider: 'provider-name',
      modelName: tags['provider.request.model'] || 'unknown',
      kind: 'llm',  // 'llm', 'embedding', 'workflow', 'task', 'tool', 'retrieval'
      name: 'provider.chat.completions'
    }
  }

  // Required method 2: Extract and tag LLM data
  setLLMObsTags(ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const inputs = ctx.arguments?.[0]
    const results = ctx.result
    const error = ctx.error

    // Always tag inputs
    this.tagInputMessages(span, this.extractInputMessages(inputs))

    if (error) {
      // Tag empty outputs on error
      this.tagOutputMessages(span, [{ content: '', role: '' }])
    } else if (results) {
      // Tag outputs on success
      this.tagOutputMessages(span, this.extractOutputMessages(results))
      this.tagMetrics(span, this.extractTokenUsage(results))
      this.tagMetadata(span, this.extractMetadata(inputs))
    }
  }

  // Helper methods (implement based on provider API)
  extractInputMessages(inputs) { /* ... */ }
  extractOutputMessages(results) { /* ... */ }
  extractTokenUsage(results) { /* ... */ }
  extractMetadata(inputs) { /* ... */ }
}

module.exports = [ProviderLLMObsPlugin]
```

## Required Methods

### getLLMObsSpanRegisterOptions(ctx)

Defines span metadata for registration with LLMObs.

**Parameters:**
- `ctx` - Plugin context containing current store, span, inputs, outputs

**Returns:** Object with:
- `modelProvider` (string): Provider name (e.g., 'openai', 'anthropic', 'google')
- `modelName` (string): Model identifier (e.g., 'gpt-4', 'claude-3-sonnet')
- `kind` (string): Span kind - always `'llm'` for chat completions
- `name` (string): Operation name (e.g., 'openai.chat.completions')

**Example:**
```javascript
getLLMObsSpanRegisterOptions(ctx) {
  const span = ctx.currentStore?.span
  const tags = span?.context()._tags || {}

  return {
    modelProvider: 'openai',
    modelName: tags['openai.request.model'] || 'unknown',
    kind: 'llm',
    name: 'openai.chat.completions'
  }
}
```

### setLLMObsTags(ctx)

Extracts and tags LLM-specific data after operation completes.

**Parameters:**
- `ctx` - Plugin context with inputs, outputs, error

**Responsibilities:**
1. Extract input messages from request parameters
2. Extract output messages from response
3. Extract token usage metrics
4. Extract model parameters (metadata)
5. Tag all data using helper methods

**Pattern:**
```javascript
setLLMObsTags(ctx) {
  const span = ctx.currentStore?.span
  if (!span) return

  const inputs = ctx.arguments?.[0]
  const results = ctx.result
  const error = ctx.error

  // Extract and tag inputs (always)
  const inputMessages = this.extractInputMessages(inputs)
  this.tagInputMessages(span, inputMessages)

  // Handle error case
  if (error) {
    this.tagOutputMessages(span, [{ content: '', role: '' }])
    return
  }

  // Extract and tag outputs
  if (results) {
    this.tagOutputMessages(span, this.extractOutputMessages(results))
    this.tagMetrics(span, this.extractTokenUsage(results))
    this.tagMetadata(span, this.extractMetadata(inputs))
  }
}
```

## Helper Methods

### extractInputMessages(inputs)

Converts provider-specific input format to standard `[{content, role}]` array.

**Common patterns:**
- Messages array: `inputs.messages.map(msg => ({content: msg.content, role: msg.role}))`
- Prompt string: `[{content: inputs.prompt, role: 'user'}]`
- Contents array: `inputs.contents.map(item => ({content: item.parts[0].text, role: item.role}))`
- Direct string: `[{content: inputs, role: 'user'}]`

See `message-extraction.md` for provider-specific details.

### extractOutputMessages(results)

Converts provider-specific output format to standard `[{content, role: 'assistant'}]` array.

**Common patterns:**
- OpenAI: `[{content: results.choices[0].message.content, role: 'assistant'}]`
- Anthropic: `[{content: results.content[0].text, role: 'assistant'}]`
- Google: Extract from `results.candidates[0].content.parts`
- Fallback: `[{content: '', role: ''}]` on error

### extractTokenUsage(results)

Returns `{input_tokens, output_tokens, total_tokens}` from `results.usage`.

Handle both OpenAI format (`prompt_tokens`, `completion_tokens`) and standard format.

### extractMetadata(inputs)

Returns model parameters: `temperature`, `max_tokens`, `top_p`, `top_k`, `stream`.

## Tagging Methods (Inherited from Base)

These methods are provided by `LLMObsPlugin` base class:

### tagInputMessages(span, messages)

Tags input messages on span.

**Usage:**
```javascript
this.tagInputMessages(span, [
  { content: 'Hello', role: 'user' }
])
```

### tagOutputMessages(span, messages)

Tags output messages on span.

**Usage:**
```javascript
this.tagOutputMessages(span, [
  { content: 'Hi there!', role: 'assistant' }
])
```

### tagMetrics(span, metrics)

Tags token usage metrics on span.

**Usage:**
```javascript
this.tagMetrics(span, {
  input_tokens: 10,
  output_tokens: 20,
  total_tokens: 30
})
```

### tagMetadata(span, metadata)

Tags model parameters on span.

**Usage:**
```javascript
this.tagMetadata(span, {
  temperature: 0.7,
  max_tokens: 1024
})
```

## Plugin Lifecycle

1. **start(ctx)** - Called when operation starts
   - Registers span with LLMObs
   - Captures parent context

2. **Operation executes** - Chat completion call happens

3. **asyncEnd(ctx)** - Called after operation completes
   - Calls `setLLMObsTags()` to extract data
   - Tags span with all LLM data

4. **end(ctx)** - Called to clean up
   - Restores parent context

## Error Handling

Always tag empty outputs on error:

```javascript
if (error) {
  this.tagOutputMessages(span, [{ content: '', role: '' }])
  return
}
```

This ensures span structure is consistent even when operations fail.

## Complete Working Example

See existing plugins for reference:
- `packages/dd-trace/src/llmobs/plugins/openai/index.js` - OpenAI implementation
- `packages/datadog-plugin-anthropic/src/llmobs.js` - Anthropic implementation
- `packages/datadog-plugin-google-genai/src/llmobs.js` - Google GenAI implementation

Key pattern: Extend `LLMObsPlugin`, implement two required methods, add four extraction helpers, export as array.
