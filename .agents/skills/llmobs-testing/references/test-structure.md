# Test Structure Reference

Complete guide to organizing LLMObs test files.

## ⚠️ CRITICAL: ALL Tests Must Use `withVersions()` ⚠️

**`withVersions()` is required in every LLMObs test, without exception.**

`withVersions()` adds the version wrapper's `node_modules` to `NODE_PATH` and calls `Module._initPaths()`. Without it, the orchestrion rewriter cannot find and instrument the module files — no APM spans are produced, `getEvents()` hangs indefinitely, and all tests timeout.

**This is not optional. Do not use bare `require('package-name')` at the top of the file or in `beforeEach`.**

## File Template

```javascript
'use strict'

const assert = require('node:assert')
const { describe, before, it } = require('mocha')
const { withVersions } = require('../../../setup/mocha')  // ← REQUIRED

const {
  useLlmObs,
  assertLlmObsSpanEvent,
  MOCK_STRING,
  MOCK_NOT_NULLISH,
} = require('../../util')

describe('integrations', () => {
  describe('my-integration', () => {
    const { getEvents } = useLlmObs({ plugin: 'my-integration' })

    withVersions('my-integration', 'my-package', (version) => {  // ← REQUIRED WRAPPER
      let client

      before(() => {
        // Load module inside withVersions callback using the versioned require path
        const MyClient = require(`../../../../../../versions/my-package@${version}`).get()
        client = new MyClient({
          apiKey: 'test-api-key',
          baseURL: 'http://127.0.0.1:9126/vcr/my-integration'  // VCR proxy (LLM_CLIENT only)
        })
      })

      describe('chat completions', () => {
        it('creates a span', async () => {
          const result = await client.chat({
            messages: [{ role: 'user', content: 'Hello' }],
            model: 'test-model',
            temperature: 0.7,
          })

          assert.ok(result)

          const { apmSpans, llmobsSpans } = await getEvents()  // ← always destructure

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
              total_tokens: MOCK_NOT_NULLISH,
            },
            metadata: { temperature: 0.7 },
          })
        })

        it('handles errors', async () => {
          try {
            await client.chat({ messages: [], model: 'invalid' })
          } catch (err) {
            // expected
          }

          const { llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            spanKind: 'llm',
            outputMessages: [{ content: '', role: '' }],
            error: MOCK_NOT_NULLISH,
          })
        })
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
- `plugin` (string or string[]): Plugin name(s) to test

**Returns:**
- `getEvents()` async function — always `await` it and destructure the result

**Usage:**
Call `useLlmObs()` once at the inner `describe` level (inside `describe('my-integration', ...)`) but outside `withVersions`. Call `getEvents()` in each test after the instrumented operation completes.

## getEvents() Usage

```javascript
const { apmSpans, llmobsSpans } = await getEvents()
```

**Returns:** `{ apmSpans, llmobsSpans }` — an object with two arrays.

**Usage:**
- Always `await` and destructure
- `llmobsSpans[0]` for first/only LLMObs span
- `apmSpans[0]` for the corresponding APM span (pass as `span:` to `assertLlmObsSpanEvent`)
- `llmobsSpans.length` to assert span count

## Module Loading Pattern

**Every test must use `withVersions()` and load modules inside its callback using the versioned path.**

```javascript
withVersions('plugin-name', 'npm-package-name', (version) => {
  let MyLib

  before(() => {
    // ✅ Correct: versioned require inside withVersions callback
    MyLib = require(`../../../../../../versions/npm-package-name@${version}`).get()
  })

  // tests go here...
})
```

**Why `withVersions()` is mandatory:**
- Sets `NODE_PATH` to include the version wrapper's `node_modules`
- Calls `Module._initPaths()` so the orchestrion rewriter can locate the module
- Without it: orchestrion can't instrument the module → no APM spans → `getEvents()` hangs → all tests timeout

**Bad pattern — will cause all tests to silently hang:**
```javascript
// ❌ FATAL: bare require outside withVersions
const MyLib = require('my-lib')

// ❌ FATAL: bare require inside beforeEach (not versioned, not wrapped)
beforeEach(() => {
  MyLib = require('my-lib')
})

// ❌ FATAL: hardcoded version range without withVersions wrapper
before(() => {
  MyLib = require('../../../../../../versions/my-lib@>=1.0.0').get()
})
```

**Good pattern:**
```javascript
// ✅ withVersions wrapper + versioned require inside callback
withVersions('my-plugin', 'my-lib', (version) => {
  before(() => {
    MyLib = require(`../../../../../../versions/my-lib@${version}`).get()
  })
})
```

## Test Organization

Group by method (`describe('chat completions')`, `describe('tool calls')`) or by scenario (`describe('basic usage')`, `describe('error handling')`).

## before / beforeEach

- **`before()`**: Use for one-time setup (creating clients, mock servers). Most LLMObs tests use `before()` inside `withVersions`.
- **`beforeEach()`**: Use for orchestration tests that need fresh module state per test, or when resetting server state between tests.
- **`after()` / `afterEach()`**: Use for cleanup (closing connections, stopping servers).

## Imports

```javascript
const { withVersions } = require('../../../setup/mocha')  // always required
const { useLlmObs, assertLlmObsSpanEvent, MOCK_STRING, MOCK_NOT_NULLISH } = require('../../util')
```

## Assertions

```javascript
const { apmSpans, llmobsSpans } = await getEvents()
assert.strictEqual(llmobsSpans.length, 1)
assertLlmObsSpanEvent(llmobsSpans[0], { span: apmSpans[0], spanKind: 'llm', ... })
```

## Testing Orchestration (ORCHESTRATION category)

**No VCR, pure functions, `beforeEach` for fresh module state:**

```javascript
describe('integrations', () => {
  let StateGraph, Annotation

  describe('langgraph', () => {
    const { getEvents } = useLlmObs({ plugin: ['langgraph', 'langchain'] })

    withVersions('langgraph', '@langchain/langgraph', (version) => {
      beforeEach(() => {
        // Fresh module each test for state isolation
        const langgraph = require(`../../../../../../versions/@langchain/langgraph@${version}`).get()
        StateGraph = langgraph.StateGraph
        Annotation = langgraph.Annotation
      })

      describe('Pregel.stream', () => {
        it('creates a workflow span', async () => {
          const StateAnnotation = Annotation.Root({
            messages: Annotation({ reducer: (x, y) => x.concat(y), default: () => [] }),
          })

          const workflow = new StateGraph(StateAnnotation)
            .addNode('chat', (state) => ({ messages: [{ role: 'assistant', content: 'Mock' }] }))
            .addEdge('__start__', 'chat')
            .addEdge('chat', '__end__')

          const app = workflow.compile({ name: 'test-graph' })

          for await (const chunk of await app.stream({ messages: [{ role: 'user', content: 'Test' }] })) {
            // consume stream
          }

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',  // NOT 'llm'
            name: 'langgraph.graph.stream',
          })
        })
      })
    })
  })
})
```

## Testing Tool Clients (TOOL_CLIENT category)

**Mock server via InMemoryTransport (for MCP SDK), `before()` for setup, `after()` for teardown:**

```javascript
describe('integrations', () => {
  let Client, Server, InMemoryTransport
  let client, server

  describe('modelcontextprotocol-sdk', () => {
    const { getEvents } = useLlmObs({ plugin: 'modelcontextprotocol-sdk' })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', (version) => {
      before(async () => {
        // Load submodules via versioned require inside withVersions
        Client = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
          .get('@modelcontextprotocol/sdk/client').Client
        Server = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
          .get('@modelcontextprotocol/sdk/server').Server
        InMemoryTransport = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
          .get('@modelcontextprotocol/sdk/inMemory.js').InMemoryTransport

        server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } })
        // register handlers...

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        client = new Client({ name: 'test-client', version: '1.0.0' })
        await client.connect(clientTransport)
      })

      after(async () => {
        await client?.close()
        await server?.close()
      })

      describe('Client.callTool', () => {
        it('creates a tool span', async () => {
          await client.callTool({ name: 'my-tool', arguments: {} })

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'tool',
            name: 'mcp.tool.my-tool',
          })
        })
      })
    })
  })
})
```

## Common Pitfalls

### Pitfall 1: Missing `withVersions()` → tests silently hang

```javascript
// ❌ FATAL — orchestrion can't instrument, getEvents() hangs forever
before(async () => {
  const mod = require('../../../../../../versions/@modelcontextprotocol/sdk@>=1.27.1')
    .get('@modelcontextprotocol/sdk/client')
  Client = mod.Client
})

// ✅ Correct — wrap everything in withVersions
withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', (version) => {
  before(async () => {
    Client = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
      .get('@modelcontextprotocol/sdk/client').Client
  })
})
```

### Pitfall 2: Forgetting to await getEvents()

```javascript
// ❌ Bad — getEvents() is async
const events = getEvents()
assertLlmObsSpanEvent(events[0], { ... })  // events is a Promise, not an object!

// ✅ Good
const { apmSpans, llmobsSpans } = await getEvents()
assertLlmObsSpanEvent(llmobsSpans[0], { ... })
```

### Pitfall 3: Using VCR for orchestration or tool clients

```javascript
// ❌ Bad (orchestration with VCR)
client = new StateGraph({ baseURL: 'http://127.0.0.1:9126/vcr/langgraph' })

// ✅ Good (orchestration without VCR)
const graph = new StateGraph(StateAnnotation)  // pure functions
```

### Pitfall 4: Not isolating module state for orchestration

```javascript
// ❌ Bad (shared state — orchestration libs accumulate state)
withVersions('langgraph', '@langchain/langgraph', (version) => {
  before(() => {  // Only once — state leaks between tests
    langgraph = require(`...`).get()
  })
})

// ✅ Good (fresh state per test)
withVersions('langgraph', '@langchain/langgraph', (version) => {
  beforeEach(() => {  // Fresh each test
    langgraph = require(`...`).get()
  })
})
```

## Working Examples

Study these test files as templates:

- `packages/dd-trace/test/llmobs/plugins/anthropic/index.spec.js` — LLM_CLIENT with `before()` + VCR
- `packages/dd-trace/test/llmobs/plugins/google-genai/index.spec.js` — LLM_CLIENT nested format
- `packages/dd-trace/test/llmobs/plugins/openai/openaiv4.spec.js` — LLM_CLIENT simple format
- `packages/dd-trace/test/llmobs/plugins/langgraph/index.spec.js` — ORCHESTRATION with `beforeEach()`
- `packages/dd-trace/test/llmobs/plugins/ai/index.spec.js` — MULTI_PROVIDER format
