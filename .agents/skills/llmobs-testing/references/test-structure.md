# Test Structure Reference

Complete guide to organizing LLMObs test files.

## File Template

```javascript
'use strict'

const { useLlmObs, assertLlmObsSpanEvent, MOCK_STRING, MOCK_NOT_NULLISH } = require('../../util')

describe('my-integration LLMObs', () => {
  const { getEvents } = useLlmObs({ plugin: 'my-integration' })

  let MyClient
  let client

  beforeEach(() => {
    // Load module fresh for each test
    MyClient = require('my-integration')

    // Initialize client with VCR proxy (if using VCR)
    client = new MyClient({
      apiKey: 'test-api-key',
      baseURL: 'http://127.0.0.1:9126/vcr/my-integration'
    })
  })

  afterEach(() => {
    // Cleanup if needed
  })

  describe('chat completions', () => {
    it('instruments basic chat', async () => {
      const result = await client.chat({
        messages: [{ role: 'user', content: 'Hello' }],
        model: 'test-model',
        temperature: 0.7
      })

      const { apmSpans, llmobsSpans } = await getEvents()

      assertLlmObsSpanEvent(llmobsSpans[0], {
        span: apmSpans[0],
        spanKind: 'llm',
        name: 'my-integration.chat',
        modelName: 'test-model',
        modelProvider: 'my-integration',
        inputMessages: [{ content: 'Hello', role: 'user' }],
        outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
        metrics: {
          input_tokens: MOCK_NOT_NULLISH,
          output_tokens: MOCK_NOT_NULLISH,
          total_tokens: MOCK_NOT_NULLISH
        },
        metadata: {
          temperature: 0.7
        }
      })
    })

    it('handles errors', async () => {
      const error = await client.chat({ messages: [], model: 'invalid' }).catch(error => error)

      const { apmSpans, llmobsSpans } = await getEvents()

      assertLlmObsSpanEvent(llmobsSpans[0], {
        span: apmSpans[0],
        spanKind: 'llm',
        outputMessages: [{ content: '', role: '' }],
        error: { type: 'Error', message: error.message, stack: error.stack }
      })
    })
  })
})
```

## useLlmObs And getEvents

```javascript
const { getEvents, assertNoLlmObsSpans, getEvaluationMetrics } =
  useLlmObs({ plugin: 'integration-name', tracerConfigOptions: {} })
```

Call `useLlmObs()` once per `describe`; it installs its own `before` / `after` hooks. `getEvents(count = 1)` is
async and resolves `{ apmSpans, llmobsSpans }` once that many LLMObs span events have arrived, in creation
order, so a spec that asks for the wrong count times out rather than failing an assertion:

```javascript
const { apmSpans, llmobsSpans } = await getEvents(2)
```

## Module Loading Pattern

**Critical for state isolation:**

```javascript
let MyLib
let client

beforeEach(() => {
  // Fresh require each test
  MyLib = require('my-lib')
  client = new MyLib()
})
```

A require at file scope is shared by every test and runs before the tracer exists, so the exports it captures
are never instrumented. See
[category-strategies.md](category-strategies.md) for the fixture form and why the hook matters.

## Test Organization

Group by method (`describe('chat completions')`, `describe('embeddings')`) or by scenario (`describe('basic usage')`,
`describe('error handling')`).

## Assertions

```javascript
const { useLlmObs, assertLlmObsSpanEvent, MOCK_STRING, MOCK_NOT_NULLISH } = require('../../util')

const { apmSpans, llmobsSpans } = await getEvents()
assert.strictEqual(llmobsSpans.length, 1)
assertLlmObsSpanEvent(llmobsSpans[0], { span: apmSpans[0], spanKind: 'llm' })
```

Per-shape patterns, including the orchestration spec that answers its own nodes rather than recording
cassettes, live in [category-strategies.md](category-strategies.md).

## Working Examples

Study these test files as templates:

- `packages/dd-trace/test/llmobs/plugins/openai/openaiv4.spec.js` - Simple format
- `packages/dd-trace/test/llmobs/plugins/anthropic/index.spec.js` - Complex format
- `packages/dd-trace/test/llmobs/plugins/google-genai/index.spec.js` - Nested format
- `packages/dd-trace/test/llmobs/plugins/langgraph/index.spec.js` - Orchestration
