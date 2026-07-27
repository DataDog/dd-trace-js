# Assertion Helpers Reference

Complete guide to `assertLlmObsSpanEvent()` and mock matchers for validating LLMObs span events.

## assertLlmObsSpanEvent

Main assertion function for validating LLMObs span structure. Only the fields you specify are checked — unspecified
fields are ignored.

See the docstring in `packages/dd-trace/test/llmobs/util.js` for the full type signature and parameter details.

## Mock Matchers

Use these for non-deterministic values (output text, token counts, errors).

| Matcher | Matches | Example Use Case |
|---------|---------|------------------|
| `MOCK_STRING` | Any string, `''` included | Output message content (varies per run) |
| `MOCK_NOT_NULLISH` | Anything but `null` / `undefined` | Token counts (exist but vary) |
| `MOCK_NUMBER` | Any number | Specific numeric metrics |
| `MOCK_OBJECT` | Anything with `typeof 'object'`, `null` included | Opaque `schema` / `metadata`, whole messages |

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
const { apmSpans, llmobsSpans } = await getEvents()

assertLlmObsSpanEvent(llmobsSpans[0], {
  span: apmSpans[0],
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

### 2. Workflow/Orchestration Span

```javascript
assertLlmObsSpanEvent(llmobsSpans[0], {
  spanKind: 'workflow',  // Not 'llm'!
  name: 'langgraph.graph.invoke'
  // Workflows may not have inputMessages/outputMessages
})
```

### 3. Error Case

```javascript
assertLlmObsSpanEvent(llmobsSpans[0], {
  spanKind: 'llm',
  outputMessages: [{ content: '', role: '' }],  // Empty on error
  error: { type: 'Error', message: error.message, stack: error.stack }
})

assert.strictEqual(apmSpans[0].meta['error.message'], error.message)
```

The helper fills `error.message`, `error.type` and `error.stack` from the span it is checking, so the
`error` option decides `status: 'error'` and nothing else. The fields written into it document the throw;
the assertion on the APM span is what pins which error was thrown.

Values you control in the spec — input messages, model name, model parameters — are pinned exactly; only
what the provider decides gets a matcher.

## Reference Test Implementation

For a complete, real-world example of how tests using these helpers are structured, see:
- [`packages/dd-trace/test/llmobs/plugins/anthropic/index.spec.js`](../../../../packages/dd-trace/test/llmobs/plugins/anthropic/index.spec.js)
  (LLM client / multi-provider pattern)
- [`packages/dd-trace/test/llmobs/plugins/google-genai/index.spec.js`](../../../../packages/dd-trace/test/llmobs/plugins/google-genai/index.spec.js)
  (LLM client pattern)
- [`packages/dd-trace/test/llmobs/plugins/langgraph/index.spec.js`](../../../../packages/dd-trace/test/llmobs/plugins/langgraph/index.spec.js)
  (orchestration pattern)

## Fields Per Span Kind

`spanKind` and `name` are on every span. The rest follow the kind, and a field the kind never emits fails:

| Kind | Fields |
|------|--------|
| `llm` | `modelName`, `modelProvider`, `inputMessages`, `outputMessages`, `metrics`, `metadata` |
| `embedding` | `modelName`, `modelProvider`, `inputDocuments`, `outputValue`, sometimes `metrics` |
| `retrieval` | `inputValue`, `outputDocuments` |
| `workflow`, `agent`, `task`, `step`, `tool` | `inputValue`, `outputValue`, `metadata` |
