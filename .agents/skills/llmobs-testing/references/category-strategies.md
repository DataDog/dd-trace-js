# Test Strategy Per Package Shape

The strategies do not mix: each shape forbids what another requires, so a spec written against the
wrong one fails on contract rather than on behaviour.

## Quick Reference: What's FORBIDDEN vs REQUIRED

### Orchestration (langgraph)

**FORBIDDEN:**
- ❌ VCR cassettes or VCR proxy URLs
- ❌ `new Client()` classes (orchestration libraries don't have Client classes)
- ❌ HTTP configuration (baseURL, httpOptions)
- ❌ Real API calls to LLM providers
- ❌ spanKind: 'llm' (use 'workflow' or 'agent' instead)
- ❌ modelName, modelProvider fields (this isn't an LLM API)

**REQUIRED:**
- ✅ Pure function tests using library's native APIs (StateGraph, invoke, stream)
- ✅ Mock LLM responses as simple return values
- ✅ spanKind: 'workflow' or 'agent'
- ✅ Test orchestration logic, not API calls

### LLM client (openai, anthropic, genai)

**FORBIDDEN:**
- ❌ Tests that skip the SDK and tag spans by hand
- ❌ spanKind: 'workflow' (use 'llm' instead)

**REQUIRED:**
- ✅ Calls through the real client, answered by a cassette on the proxy baseURL or by a canned `fetch`
- ✅ spanKind: 'llm'
- ✅ modelName, modelProvider fields

### Multi-provider (ai, langchain)

Same as LLM client. `ai` records cassettes for some providers and hands a canned `fetch` to others.

### Infrastructure (modelcontextprotocol-sdk)

**REQUIRED:**
- ✅ The SDK's real server and client over its in-memory transport
- ❌ NO VCR

---

## Overview

Test strategy depends on package category:

| Package shape | VCR | Real APIs | Mock LLMs | Strategy |
|----------------|-----|-----------|-----------|----------|
| LLM client | ✅ Yes | ✅ Yes | ❌ No | VCR with real API calls |
| Multi-provider | ✅ Yes | ✅ Yes | ❌ No | VCR with real API calls |
| Orchestration | ❌ No | ❌ No | ✅ Yes | Pure functions, mock responses |
| Infrastructure | ❌ No | ❌ No | ✅ Yes | SDK server over in-memory transport |

A cassette is the default source of responses for the first two rows. Where the client takes a `fetch` option
(openai-agents, some `ai` providers) or only reaches for `global.fetch` (google-cloud-vertexai), the spec answers the
call itself instead.

## LLM client & multi-provider

**Strategy:** VCR with real API calls through proxy

### Setup

```javascript
const client = new MyLLMClient({
  apiKey: 'test-key',
  baseURL: 'http://127.0.0.1:9126/vcr/provider'  // VCR proxy
})
```

### Test Pattern

```javascript
it('instruments chat completion', async () => {
  // Real API call (first run records, subsequent replays)
  const response = await client.chat.completions.create({
    messages: [{ role: 'user', content: 'Hello' }],
    model: 'gpt-4'
  })

  const { apmSpans, llmobsSpans } = await getEvents()

  assertLlmObsSpanEvent(llmobsSpans[0], {
    span: apmSpans[0],
    spanKind: 'llm',
    modelName: 'gpt-4',
    inputMessages: [{ content: 'Hello', role: 'user' }],
    outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
    metrics: { input_tokens: MOCK_NOT_NULLISH }
  })
})
```

### ⚠️ Require The SDK Inside `before()`

A module is instrumented by the `require` that runs after the hooks are installed: RITM's patched require pulls
the exports (from Node's cache if they are already there) and hands them to every registered hook.
`useLlmObs()` loads the tracer from its own `before()` hook, so a file-scope `require` returns the exports as
they were before any hook existed. Load the version fixtures from `before()`:

```javascript
withVersions('openai-agents', '@openai/agents', (version) => {
  before(() => {
    agentsCore = require(`../../../../../../versions/@openai/agents@${version}`).get()
    const { OpenAIResponsesModel } =
      require(`../../../../../../versions/@openai/agents-openai@${version}`).get()
  })
})
```

Order between the two does not matter here: `packages/datadog-instrumentations/src/openai-agents.js` hooks both
`@openai/agents` and `@openai/agents-openai`. Where a spec's comment does ask for an order — the MCP spec requires
its client entry before the server — keep it.

**Symptom when wrong:** tests time out — `getEvents()` never resolves, no APM traces arrive, only the SDK's own
internal tracing output appears.

## Orchestration

**Strategy:** Pure function tests, NO VCR, NO real API calls

### Setup

```javascript
// No VCR proxy - use library directly
const { StateGraph, Annotation } = require('@langchain/langgraph')
```

### Test Pattern

```javascript
it('instruments graph invoke', async () => {
  // Create graph with mock LLM responses
  const graph = new StateGraph({
    channels: {
      messages: Annotation.Root({
        reducer: (x, y) => x.concat(y)
      })
    }
  })

  // Add node with mock LLM response (no real API call)
  graph.addNode('agent', async (state) => ({
    messages: [{ role: 'assistant', content: 'Mock LLM response' }]
  }))

  graph.addEdge(START, 'agent')
  graph.addEdge('agent', END)

  const compiled = graph.compile()

  // Invoke with mock data
  const result = await compiled.invoke({
    messages: [{ role: 'user', content: 'Test' }]
  })

  const { apmSpans, llmobsSpans } = await getEvents()

  assertLlmObsSpanEvent(llmobsSpans[0], {
    span: apmSpans[0],
    spanKind: 'workflow',  // Not 'llm'!
    name: 'langgraph.graph.invoke'
  })
})
```

### Key Points

- ❌ NO VCR proxy
- ❌ NO real API calls
- ❌ NO external LLM services
- ❌ NO API keys required
- ✅ Use library's native state management
- ✅ Use pure functions returning mock data
- ✅ Test workflow/graph state transitions
- ✅ Mock LLM responses as simple objects
- ✅ Load modules in `beforeEach()` for fresh state

### Why No VCR?

Orchestration tools don't make HTTP calls themselves - they coordinate other libraries that do. Testing them requires
testing the orchestration logic, not API interactions.

## Infrastructure

**Strategy:** the SDK's own server and client, wired over its in-memory transport

### Setup

```javascript
const server = new McpServer({ name: 'test-server', version: '1.0.0' })
server.registerTool('test-tool', { description: 'A test tool', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'Result from test-tool' }],
}))

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)

client = new Client({ name: 'test-client', version: '1.0.0' })
await client.connect(clientTransport)
```

### Test Pattern

```javascript
it('creates a tool span for a basic tool call', async () => {
  const result = await client.callTool({ name: 'test-tool', arguments: {} })

  const { apmSpans, llmobsSpans } = await getEvents()

  assertLlmObsSpanEvent(llmobsSpans[0], {
    span: apmSpans[0],
    spanKind: 'tool',
    name: 'MCP Client Tool Call: test-tool',
    inputValue: JSON.stringify({ name: 'test-tool', arguments: {} }),
    tags: { ml_app: 'test', integration: 'modelcontextprotocol-sdk', mcp_tool_kind: 'client' },
  })
})
```

### Key Points

- ❌ NO VCR, and no hand-rolled fake server — the tool handlers you register are the canned responses
- ✅ Span kinds `'tool'` for tool calls and `'task'` for the rest of the protocol
- ✅ Protocol-specific tags (`mcp_tool_kind`, `mcp_server_name`, `mcp_server_version`)
- ✅ `inputValue` / `outputValue` carry the JSON-stringified protocol payloads

## Which Row Applies

The question that picks the row is whether the package itself speaks HTTP to a provider. Pointing an
orchestrator at a proxy baseURL, or letting a node inside a graph construct a real client, tests the provider
instead of the graph; letting a client reach `https://api.openai.com` needs a key and stops being
deterministic.

## Examples by Shape

### LLM client: OpenAI (VCR)

```javascript
const openai = new OpenAI({
  apiKey: 'test',
  baseURL: 'http://127.0.0.1:9126/vcr/openai'
})
await openai.chat.completions.create({ ... })
```

### Multi-provider: Vercel AI SDK (VCR)

```javascript
const model = createOpenAI({
  apiKey: 'test',
  baseURL: 'http://127.0.0.1:9126/vcr/openai'
})
await generateText({ model, prompt: '...' })
```

### Orchestration: LangGraph (Pure Functions)

```javascript
graph.addNode('agent', async (state) => ({
  messages: [{ role: 'assistant', content: 'Mock' }]
}))
await graph.invoke({ ... })
```

### Infrastructure: MCP

```javascript
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)
await client.connect(clientTransport)
await client.callTool({ name: 'test-tool', arguments: {} })
```
