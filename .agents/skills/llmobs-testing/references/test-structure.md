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

      const events = getEvents()
      expect(events).to.have.lengthOf(1)

      assertLlmObsSpanEvent(events[0], {
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
      try {
        await client.chat({ messages: [], model: 'invalid' })
      } catch (err) {
        // Expected error
      }

      const events = getEvents()

      assertLlmObsSpanEvent(events[0], {
        spanKind: 'llm',
        outputMessages: [{ content: '', role: '' }],
        error: MOCK_NOT_NULLISH
      })
    })
  })
})
```

## useLlmObs Configuration

```javascript
const { getEvents } = useLlmObs({ plugin: 'integration-name' })
```

**Parameters:**
- `plugin` (string): Plugin name to test

**Returns:**
- `getEvents()` function that returns captured span events

**Usage:**
Call `useLlmObs()` once at describe block level, then call `getEvents()` in each test.

## getEvents() Usage

```javascript
const events = getEvents()
```

**Returns:** Array of captured LLMObs span events

**Usage:**
- Call after instrumented operation completes
- Returns spans in creation order
- Use `events[0]` for first/only span
- Use `events.length` to assert count

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

**Why this matters:**
- Ensures clean state between tests
- Prevents test pollution
- Especially important for orchestration packages with state management
- Allows each test to start fresh

**Bad pattern (don't do this):**
```javascript
// At top of file
const MyLib = require('my-lib')  // ❌ Shared across all tests

describe('tests', () => {
  it('test 1', () => { ... })  // May affect test 2
  it('test 2', () => { ... })  // May be affected by test 1
})
```

## Test Organization

Group by method (`describe('chat completions')`, `describe('embeddings')`) or by scenario (`describe('basic usage')`, `describe('error handling')`).

## beforeEach / afterEach

Standard: Load module in `beforeEach`, cleanup in `afterEach` if needed.
Async: Use `async beforeEach/afterEach` if initialization/cleanup is async.

## Imports

```javascript
const { useLlmObs, assertLlmObsSpanEvent, MOCK_STRING, MOCK_NOT_NULLISH } = require('../../util')
```

## Assertions

```javascript
const events = getEvents()
expect(events).to.have.lengthOf(1)
assertLlmObsSpanEvent(events[0], { spanKind: 'llm', ... })
```

## Testing Orchestration (Category 3)

**No VCR, pure functions:**

```javascript
describe('langgraph', () => {
  const { getEvents } = useLlmObs({ plugin: 'langgraph' })

  let StateGraph, Annotation

  beforeEach(() => {
    // Fresh import
    const langgraph = require('@langchain/langgraph')
    StateGraph = langgraph.StateGraph
    Annotation = langgraph.Annotation
  })

  it('instruments graph invoke', async () => {
    const graph = new StateGraph({
      channels: {
        messages: Annotation.Root({ ... })
      }
    })

    graph.addNode('agent', async (state) => ({
      messages: [{ role: 'assistant', content: 'Mock response' }]
    }))

    const result = await graph.invoke({ messages: [...] })

    assertLlmObsSpanEvent(events[0], {
      spanKind: 'workflow',  // Not 'llm'
      name: 'langgraph.graph.invoke'
    })
  })
})
```

## Common Pitfalls

### Pitfall 1: Forgetting to call getEvents()

```javascript
// ❌ Bad
it('test', async () => {
  await client.chat({ ... })
  // Missing: const events = getEvents()
  assertLlmObsSpanEvent(undefined, { ... })  // Error!
})

// ✅ Good
it('test', async () => {
  await client.chat({ ... })
  const events = getEvents()
  assertLlmObsSpanEvent(events[0], { ... })
})
```

### Pitfall 2: Using VCR for orchestration

```javascript
// ❌ Bad (orchestration with VCR)
const client = new LangGraph({
  baseURL: 'http://127.0.0.1:9126/vcr/langgraph'  // Wrong!
})

// ✅ Good (orchestration without VCR)
const graph = new StateGraph({ ... })  // Pure functions
```

### Pitfall 3: Not isolating module state

```javascript
// ❌ Bad (shared state)
const MyLib = require('my-lib')  // Once at top
it('test 1', () => { ... })  // Modifies MyLib state
it('test 2', () => { ... })  // Affected by test 1

// ✅ Good (isolated)
beforeEach(() => {
  MyLib = require('my-lib')  // Fresh each test
})
```

## Working Examples

Study these test files as templates:

- `packages/dd-trace/test/llmobs/plugins/openai/index.spec.js` - Simple format
- `packages/dd-trace/test/llmobs/plugins/anthropic/index.spec.js` - Complex format
- `packages/dd-trace/test/llmobs/plugins/google-genai/index.spec.js` - Nested format
- `packages/dd-trace/test/llmobs/plugins/langchain-langgraph/index.spec.js` - Orchestration
