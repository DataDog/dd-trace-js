# Test Structure Reference

Complete guide to organizing LLMObs test files.

## File Template

```javascript
'use strict'

const assert = require('node:assert/strict')

const { useLlmObs, assertLlmObsSpanEvent, MOCK_STRING, MOCK_NOT_NULLISH } = require('../../util')

describe('my-integration LLMObs', () => {
  const { getEvents } = useLlmObs({ plugin: 'my-integration' })

  let MyClient
  let client

  before(() => {
    MyClient = require('my-integration')
  })

  beforeEach(() => {
    client = new MyClient({
      apiKey: 'test-api-key',
      baseURL: 'http://127.0.0.1:9126/vcr/my-integration'
    })
  })

  describe('chat completions', () => {
    it('instruments basic chat', async () => {
      await client.chat({
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
        metadata: { temperature: 0.7 },
        tags: { ml_app: 'test', integration: 'my-integration' }
      })
    })

    it('handles errors', async () => {
      let requestError
      await assert.rejects(
        () => client.chat({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'invalid',
          temperature: 0.7
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
        name: 'my-integration.chat',
        modelName: 'invalid',
        modelProvider: 'my-integration',
        inputMessages: [{ content: 'Hello', role: 'user' }],
        outputMessages: [{ content: '', role: '' }],
        metadata: { temperature: 0.7 },
        tags: { ml_app: 'test', integration: 'my-integration' },
        error: {}
      })
      assert.strictEqual(apmSpans[0].meta['error.message'], requestError.message)
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

**Critical for instrumentation order:**

```javascript
let MyLib
let client

before(() => {
  MyLib = require('my-lib')
})

beforeEach(() => {
  client = new MyLib()
})
```

A file-scope require runs before `useLlmObs()` installs the tracer. Register `useLlmObs()` first, require the SDK
from a `before()` or `beforeEach()` hook, and recreate mutable clients in `beforeEach()` when tests need isolation.
See [category-strategies.md](category-strategies.md) for the version-fixture form.

## Test Organization

Group by method (`describe('chat completions')`, `describe('embeddings')`) or by scenario (`describe('basic usage')`,
`describe('error handling')`).

## Assertions

Pin the number of events before asserting them, so an extra or missing span fails here rather than inside the
event comparison:

```javascript
const { apmSpans, llmobsSpans } = await getEvents()
assert.strictEqual(llmobsSpans.length, 1)
```

Then assert each event as the template above does. `span`, `spanKind`, `name` and `tags` are required — leaving
`span` or `tags` out throws a `TypeError` rather than failing an assertion — and omitted fields assert their
absence. `traceId` is the exception: it defaults to `MOCK_STRING`.

Per-shape patterns, including the orchestration spec that answers its own nodes rather than recording
cassettes, live in [category-strategies.md](category-strategies.md).

## Working Examples

Study these test files as templates:

- `packages/dd-trace/test/llmobs/plugins/openai/openaiv4.spec.js` - Simple format
- `packages/dd-trace/test/llmobs/plugins/anthropic/index.spec.js` - Complex format
- `packages/dd-trace/test/llmobs/plugins/google-genai/index.spec.js` - Nested format
- `packages/dd-trace/test/llmobs/plugins/langgraph/index.spec.js` - Orchestration
