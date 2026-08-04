# Assertion Helpers Reference

Complete guide to `assertLlmObsSpanEvent()` and mock matchers for validating LLMObs span events.

## assertLlmObsSpanEvent

Main assertion function for validating LLMObs span structure. `span`, `spanKind`, `name` and `tags` are required —
`span` and `tags` are dereferenced, so leaving either out throws a `TypeError` instead of failing an assertion.

Every other field asserts its own absence when omitted, so an expectation lists exactly what the span carries and
nothing more. `metrics` defaults to `{}` and `parentId` to the root parent id. `traceId` is the exception: it
defaults to `MOCK_STRING`.

See the `ExpectedLLMObsSpanEvent` typedef in `packages/dd-trace/test/llmobs/util.js` for the full signature.
The helper removes fields from the actual event while comparing them, so make raw-event assertions first and call
it only once per event.

## Mock Matchers

Use these for non-deterministic values (output text, token counts, errors).

| Matcher | Matches | Example Use Case |
|---------|---------|------------------|
| `MOCK_STRING` | Any string, `''` included | Output message content (varies per run) |
| `MOCK_NOT_NULLISH` | Anything but `null` / `undefined` | Token counts (exist but vary) |
| `MOCK_NUMBER` | Any number | Specific numeric metrics |
| `MOCK_OBJECT` | Anything with `typeof 'object'`, `null` included | Opaque `schema` / `metadata`, whole messages |

Import them alongside the helpers and use them inside the expected object:

```javascript
const { useLlmObs, assertLlmObsSpanEvent, MOCK_STRING, MOCK_NUMBER } = require('../../util')
```

## Common Patterns

### 1. Basic Chat Completion

`name` is the event name the plugin reports, or the APM span name when the plugin omits it; it is not a string the
spec chooses. `metadata` carries every request parameter the plugin tagged:

```javascript
await client.chat.completions.create({
  model: 'gpt-3.5-turbo',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello, OpenAI!' },
  ],
  max_tokens: 100,
  n: 1,
  stream: false,
  temperature: 0.5,
  user: 'dd-trace-test',
})

const { apmSpans, llmobsSpans } = await getEvents()

assertLlmObsSpanEvent(llmobsSpans[0], {
  span: apmSpans[0],
  spanKind: 'llm',
  name: 'OpenAI.createChatCompletion',
  modelName: 'gpt-3.5-turbo-0125',
  modelProvider: 'openai',
  inputMessages: [
    { content: 'You are a helpful assistant.', role: 'system' },
    { content: 'Hello, OpenAI!', role: 'user' },
  ],
  outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
  metrics: {
    cache_read_input_tokens: 0,
    input_tokens: MOCK_NUMBER,
    output_tokens: MOCK_NUMBER,
    reasoning_output_tokens: 0,
    total_tokens: MOCK_NUMBER,
  },
  metadata: {
    max_tokens: 100,
    n: 1,
    stream: false,
    temperature: 0.5,
    user: 'dd-trace-test',
  },
  tags: { ml_app: 'test', integration: 'openai' },
})
```

Objects are compared key for key, so a `metadata` or `metrics` literal that misses one entry fails on length.
Reach for `MOCK_NOT_NULLISH` on the whole object when the set varies across versions, as the LangChain specs do.

### 2. Workflow/Orchestration Span

The name is the graph's own name, and the input is the object the spec passed to `invoke`, JSON-stringified
the way the tagger stores it:

```javascript
assertLlmObsSpanEvent(llmobsSpans[0], {
  span: apmSpans[0],
  spanKind: 'workflow',
  name: 'my-graph',
  inputValue: JSON.stringify({ messages: [{ role: 'user', content: 'Test' }] }),
  outputValue: MOCK_STRING,
  tags: { ml_app: 'test', integration: 'langgraph' }
})
```

### 3. Error Case

```javascript
let requestError
await assert.rejects(
  () => client.chat.completions.create({
    model: 'gpt-3.5-turbo-instruct',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello, OpenAI!' },
    ],
    max_tokens: 100,
    n: 1,
    stream: false,
    temperature: 0.5,
    user: 'dd-trace-test',
  }),
  (error) => {
    requestError = error
    return true
  }
)

const { apmSpans, llmobsSpans } = await getEvents()

assertLlmObsSpanEvent(llmobsSpans[0], {
  span: apmSpans[0],
  spanKind: 'llm',
  name: 'OpenAI.createChatCompletion',
  modelName: 'gpt-3.5-turbo-instruct',
  modelProvider: 'openai',
  inputMessages: [
    { content: 'You are a helpful assistant.', role: 'system' },
    { content: 'Hello, OpenAI!', role: 'user' },
  ],
  outputMessages: [{ content: '', role: '' }],
  metadata: { max_tokens: 100, temperature: 0.5, n: 1, stream: false, user: 'dd-trace-test' },
  tags: { ml_app: 'test', integration: 'openai' },
  error: {}
})

assert.strictEqual(apmSpans[0].meta['error.message'], requestError.message)
```

The failed call tags no token metrics, so `metrics` stays out and the helper asserts `{}`.

The helper fills `error.message`, `error.type` and `error.stack` from the span it is checking, so the
`error` option is only a truthy marker that forces `status: 'error'`. A call that resolves instead of throwing
still fails on that status, and the assertion on the APM span pins which error was thrown.

Values you control in the spec — input messages, model name, model parameters, the invoke payload — are
pinned exactly; only what the provider decides gets a matcher.

## Reference Test Implementation

For a complete, real-world example of how tests using these helpers are structured, see:
- `packages/dd-trace/test/llmobs/plugins/anthropic/index.spec.js` (LLM client pattern)
- `packages/dd-trace/test/llmobs/plugins/google-genai/index.spec.js` (LLM client pattern)
- `packages/dd-trace/test/llmobs/plugins/langgraph/index.spec.js` (orchestration pattern)

## Fields Per Span Kind

`span`, `spanKind`, `name` and `tags` are on every span. The table lists possible fields; include only what the
event carries. The helper rejects an input or output field that contradicts the kind — `inputMessages` demands
`llm`, `inputDocuments` demands `embedding`, `outputDocuments` demands `retrieval`:

| Kind | Fields |
|------|--------|
| `llm` | `modelName`, `modelProvider`, `inputMessages`, `outputMessages`, `metrics`, `metadata` |
| `embedding` | `modelName`, `modelProvider`, `inputDocuments`, `outputValue`, sometimes `metrics` |
| `retrieval` | `inputValue`, `outputDocuments` |
| `workflow`, `agent`, `task`, `step`, `tool` | `inputValue`, `outputValue`, `metadata` |
