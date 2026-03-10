# Assertion Helpers Reference

Complete guide to `assertLlmObsSpanEvent()` and mock matchers for validating LLMObs span events.

## assertLlmObsSpanEvent

Main assertion function for validating LLMObs span structure.

**Signature:**
```javascript
assertLlmObsSpanEvent(actual, expected)
```

**Parameters:**
- `actual` - Span event object from `getEvents()`
- `expected` - Expected span structure with flexible matchers (only validates specified fields)

## Assertable Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `spanKind` | string (required) | Span type | `'llm'`, `'workflow'`, `'agent'`, `'tool'`, `'embedding'`, `'retrieval'` |
| `name` | string | Operation name | `'openai.chat.completions'`, `'langgraph.graph.invoke'` |
| `modelName` | string | Model identifier | `'gpt-4'`, `'claude-3-sonnet'` |
| `modelProvider` | string | Provider name | `'openai'`, `'anthropic'`, `'google'` |
| `inputMessages` | array | Input messages | `[{content: 'Hello', role: 'user'}]` |
| `outputMessages` | array | Output messages | `[{content: MOCK_STRING, role: 'assistant'}]` |
| `metrics` | object | Token usage | `{input_tokens: 10, output_tokens: 20, total_tokens: 30}` |
| `metadata` | object | Model parameters | `{temperature: 0.7, max_tokens: 1024}` |
| `error` | object | Error info (if failed) | `MOCK_OBJECT` or specific error shape |

**Message format:** `{content: string, role: string}`

## Mock Matchers

Use these for non-deterministic values (output text, token counts, errors).

| Matcher | Matches | Example Use Case |
|---------|---------|------------------|
| `MOCK_STRING` | Any non-empty string | Output message content (varies per run) |
| `MOCK_NOT_NULLISH` | Any truthy value | Token counts (exist but vary) |
| `MOCK_NUMBER` | Any number | Specific numeric metrics |
| `MOCK_OBJECT` | Any object | Error objects |

**Usage:**
```javascript
const { MOCK_STRING, MOCK_NOT_NULLISH, MOCK_NUMBER, MOCK_OBJECT } = require('../../util')

assertLlmObsSpanEvent(span, {
  outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
  metrics: { input_tokens: MOCK_NOT_NULLISH }
})
```

## Common Patterns

### 1. Basic Chat Completion

```javascript
assertLlmObsSpanEvent(events[0], {
  spanKind: 'llm',
  name: 'openai.chat.completions',
  modelName: 'gpt-4',
  modelProvider: 'openai',
  inputMessages: [{ content: 'Hello', role: 'user' }],
  outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
  metrics: {
    input_tokens: MOCK_NOT_NULLISH,
    output_tokens: MOCK_NOT_NULLISH,
    total_tokens: MOCK_NOT_NULLISH
  },
  metadata: { temperature: 0.7 }
})
```

### 2. Multi-Turn Conversation

```javascript
assertLlmObsSpanEvent(events[0], {
  spanKind: 'llm',
  inputMessages: [
    { content: 'Hello', role: 'user' },
    { content: 'Hi!', role: 'assistant' },
    { content: 'How are you?', role: 'user' }
  ],
  outputMessages: [{ content: MOCK_STRING, role: 'assistant' }]
})
```

### 3. Workflow/Orchestration Span

```javascript
assertLlmObsSpanEvent(events[0], {
  spanKind: 'workflow',  // Not 'llm'!
  name: 'langgraph.graph.invoke'
  // Workflows may not have inputMessages/outputMessages
})
```

### 4. Error Case

```javascript
assertLlmObsSpanEvent(events[0], {
  spanKind: 'llm',
  outputMessages: [{ content: '', role: '' }],  // Empty on error
  error: MOCK_OBJECT
})
```

### 5. Partial Validation

Only specified fields are checked (others ignored):

```javascript
assertLlmObsSpanEvent(events[0], {
  spanKind: 'llm',
  modelName: 'gpt-4'
  // inputMessages, outputMessages, metrics, metadata not validated
})
```

## Best Practices

1. **Use MOCK_* for non-deterministic values:**
   - Output text: `MOCK_STRING` (real responses vary)
   - Token counts: `MOCK_NOT_NULLISH` (counts vary but should exist)
   - Error objects: `MOCK_OBJECT` (error details vary)

2. **Use exact values for inputs:**
   - Input messages: You control these in tests
   - Model parameters: You set these (temperature, max_tokens)
   - Model name: You specify this

3. **Always validate core fields:**
   - `spanKind` (required for every span)
   - `name` (operation identifier)
   - `modelName` and `modelProvider` (for LLM spans)

4. **Validate message format:**
   - Ensure `{content: string, role: string}` structure
   - Check role values: `'user'`, `'assistant'`, `'system'`, `'tool'`

5. **Test error paths:**
   - Verify empty `outputMessages: [{content: '', role: ''}]` on errors
   - Assert `error` field exists with `MOCK_OBJECT`

6. **Match span kind to operation:**
   - Chat/completions → `spanKind: 'llm'`
   - Workflow execution → `spanKind: 'workflow'`
   - Agent runs → `spanKind: 'agent'`
   - Tool calls → `spanKind: 'tool'`
   - Embeddings → `spanKind: 'embedding'`

## Reference Test Implementation

For a complete, real-world example of how tests using these helpers are structured, see:
- [`packages/datadog-plugin-anthropic/test/llmobs.spec.js`](../../../../../packages/datadog-plugin-anthropic/test/llmobs.spec.js)
- [`packages/datadog-plugin-google-genai/test/llmobs.spec.js`](../../../../../packages/datadog-plugin-google-genai/test/llmobs.spec.js)

## Field Reference Quick Lookup

**Required:**
- `spanKind` - Always required

**LLM Spans:**
- `name`, `modelName`, `modelProvider`, `inputMessages`, `outputMessages`, `metrics`, `metadata`

**Workflow Spans:**
- `name` (may not have messages/metrics)

**Agent Spans:**
- `name` (may have messages for agent I/O)

**Tool Spans:**
- `name` (may have input/output for tool calls)

**Embedding Spans:**
- `name`, `modelName`, `modelProvider`, `metrics` (input/output token counts)

**Retrieval Spans:**
- `name`, `metadata` (query, results count, etc.)
