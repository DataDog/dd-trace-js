# Test Strategy Per Instrumented Surface

A package may expose several kinds of surface. Choose the response source and expected span fields for each
instrumented operation.

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

### Provider-backed LLM operation (openai, anthropic, genai)

**FORBIDDEN:**
- ❌ Tests that skip the SDK and tag spans by hand
- ❌ `spanKind: 'workflow'` for chat or generation

**REQUIRED:**
- ✅ Calls through the real client, answered by a cassette on the proxy baseURL or a canned `fetch`
- ✅ `spanKind: 'llm'`
- ✅ `modelName` and `modelProvider`

### Multi-provider (ai, langchain)

Exercise the real abstraction and provider path. `ai` records cassettes for some providers and hands a canned
`fetch` to others. Do not assign one kind to the package: `ai` and LangChain emit kinds such as `llm`, `workflow`,
`embedding`, `retrieval`, and `tool` according to the operation.

### Infrastructure (modelcontextprotocol-sdk)

**REQUIRED:**
- ✅ The SDK's real server and client over its in-memory transport
- ❌ NO VCR

---

## Overview

Response strategy depends on the surface under test:

| Surface | Response source | Harness |
|---------|-----------------|---------|
| LLM client | Provider response | Real client through VCR or a canned `fetch` |
| Multi-provider | Provider response | Real abstraction and provider through VCR or a canned `fetch` |
| Orchestration | Plain node response | Native graph/workflow APIs |
| Infrastructure | Protocol handler response | SDK server and client over in-memory transport |

A cassette is the default provider response. Where the client takes a `fetch` option (openai-agents, some `ai`
providers) or only reaches for `global.fetch` (google-cloud-vertexai), the spec answers the call itself instead.

## Provider-backed operations

**Strategy:** the real SDK path through VCR or a canned `fetch`

### Setup

```javascript
const client = new MyLLMClient({
  apiKey: 'test-key',
  baseURL: 'http://127.0.0.1:9126/vcr/provider'
})
```

### Test Pattern

```javascript
it('instruments chat completion', async () => {
  await client.chat.completions.create({
    messages: [{ role: 'user', content: 'Hello' }],
    model: 'gpt-4'
  })

  const { apmSpans, llmobsSpans } = await getEvents()

  assertLlmObsSpanEvent(llmobsSpans[0], {
    span: apmSpans[0],
    spanKind: 'llm',
    name: 'MyLLMClient.createChatCompletion',
    modelName: 'my-model',
    modelProvider: 'my-provider',
    inputMessages: [{ content: 'Hello', role: 'user' }],
    outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
    metrics: {
      input_tokens: MOCK_NOT_NULLISH,
      output_tokens: MOCK_NOT_NULLISH,
      total_tokens: MOCK_NOT_NULLISH
    },
    tags: { ml_app: 'test', integration: 'my-integration' }
  })
})
```

`name` and `modelProvider` are whatever the plugin reports, not strings the spec picks, and `tags` is required —
see [assertion-helpers.md](assertion-helpers.md) for the openai shape and the required-field list.

### Require The SDK Inside `before()`

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

`beforeEach()` works the same way and is what the openai and langgraph specs use; the requirement is any hook
rather than file scope.

Order between the two requires does not matter here: `packages/datadog-instrumentations/src/openai-agents.js` hooks
both `@openai/agents` and `@openai/agents-openai`. Where a spec's comment does ask for an order — the MCP spec
requires its client entry before the server — keep it.

**Symptom when wrong:** tests time out — `getEvents()` never resolves, no APM traces arrive, only the SDK's own
internal tracing output appears.

## Orchestration

**Strategy:** Pure function tests, NO VCR, NO real API calls

### Setup

No proxy and no client — the graph is built from the library's own exports, required from the version fixture in a
hook so the tracer is already installed:

```javascript
let StateGraph
let Annotation

beforeEach(() => {
  const langgraph = require(`../../../../../../versions/@langchain/langgraph@${version}`).get()
  StateGraph = langgraph.StateGraph
  Annotation = langgraph.Annotation
})
```

### Test Pattern

```javascript
it('creates a workflow span for streaming execution', async () => {
  const StateAnnotation = Annotation.Root({
    messages: Annotation({
      reducer: (existingMessages, newMessages) => existingMessages.concat(newMessages),
      default: () => [],
    }),
  })

  const workflow = new StateGraph(StateAnnotation)
    .addNode('chat', () => ({ messages: [{ role: 'assistant', content: 'Streaming response' }] }))
    .addEdge('__start__', 'chat')
    .addEdge('chat', '__end__')

  const app = workflow.compile({ name: 'my-graph' })

  const chunks = []
  for await (const chunk of await app.stream({ messages: [{ role: 'user', content: 'Test' }] })) {
    chunks.push(chunk)
  }
  assert.ok(chunks.length > 0, `Expected ${chunks.length} > 0`)

  const { apmSpans, llmobsSpans } = await getEvents()

  assertLlmObsSpanEvent(llmobsSpans[0], {
    span: apmSpans[0],
    spanKind: 'workflow',
    name: 'my-graph',
    inputValue: JSON.stringify({ messages: [{ role: 'user', content: 'Test' }] }),
    outputValue: MOCK_STRING,
    tags: { ml_app: 'test', integration: 'langgraph' },
  })
})
```

The instrumented entry point is `Pregel.stream`, so the span closes when the iterator is drained, and `name` is
whatever `compile({ name })` was given. The graph's state shape comes from `Annotation.Root`, and the terminal
nodes are the `'__start__'` / `'__end__'` literals the spec uses.

### Key Points

- ❌ NO VCR proxy
- ❌ NO real API calls
- ❌ NO external LLM services
- ❌ NO API keys required
- ✅ Use library's native state management
- ✅ Use pure functions returning mock data
- ✅ Test workflow/graph state transitions
- ✅ Mock LLM responses as simple objects
- ✅ Load modules after `useLlmObs()` installs the tracer

### Why No VCR?

Pure orchestration operations do not make provider HTTP calls. Their tests exercise graph state and execution rather
than a provider API.

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
  await client.callTool({ name: 'test-tool', arguments: {} })

  const { apmSpans, llmobsSpans } = await getEvents()

  assertLlmObsSpanEvent(llmobsSpans[0], {
    span: apmSpans[0],
    spanKind: 'tool',
    name: 'MCP Client Tool Call: test-tool',
    inputValue: JSON.stringify({ name: 'test-tool', arguments: {} }),
    outputValue: JSON.stringify({
      content: [{ type: 'text', text: 'Result from test-tool', annotations: {}, meta: {} }],
      isError: false,
    }),
    tags: {
      ml_app: 'test',
      integration: 'modelcontextprotocol-sdk',
      mcp_tool_kind: 'client',
      mcp_server_name: 'test-server',
      mcp_server_version: '1.0.0',
    },
  })
})
```

### Key Points

- ❌ NO VCR, and no hand-rolled fake server — the tool handlers you register are the canned responses
- ✅ Span kind `'tool'` for tool calls and `'task'` for list-tools
- ✅ Protocol-specific tags (`mcp_tool_kind`, `mcp_server_name`, `mcp_server_version`)
- ✅ `inputValue` / `outputValue` carry the JSON-stringified protocol payloads

## Which Row Applies

The question that picks the response source is whether the instrumented operation reaches a provider. Pointing an
orchestrator at a proxy baseURL, or letting a node construct a real client, tests the provider instead of the graph;
letting a client reach `https://api.openai.com` needs a key and stops being deterministic.

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
const workflow = new StateGraph(StateAnnotation)
  .addNode('chat', () => ({ messages: [{ role: 'assistant', content: 'Mock' }] }))
  .addEdge('__start__', 'chat')
  .addEdge('chat', '__end__')

const app = workflow.compile({ name: 'my-graph' })
for await (const chunk of await app.stream({ messages: [] })) { /* drain to close the span */ }
```

### Infrastructure: MCP

```javascript
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)
await client.connect(clientTransport)
await client.callTool({ name: 'test-tool', arguments: {} })
```
