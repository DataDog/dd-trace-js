# Category-Specific Test Strategies

## ⚠️ CRITICAL: Categories Are Mutually Exclusive ⚠️

**YOU CANNOT MIX STRATEGIES BETWEEN CATEGORIES.**

**Each category has FORBIDDEN and REQUIRED patterns. Violating these will cause test failure.**

---

## Quick Reference: What's FORBIDDEN vs REQUIRED

### ORCHESTRATION (langgraph, crewai, autogen)

**FORBIDDEN:**
- ❌ VCR cassettes or VCR proxy URLs
- ❌ `new Client()` classes (orchestration libraries don't have Client classes)
- ❌ HTTP configuration (baseURL, httpOptions)
- ❌ Real API calls to LLM providers
- ❌ spanKind: 'llm' (use 'workflow' or 'agent' instead)
- ❌ modelName, modelProvider fields (this isn't an LLM API)

**REQUIRED:**
- ✅ `withVersions()` wrapper (required for orchestrion rewriter — no exceptions)
- ✅ Pure function tests using library's native APIs (StateGraph, invoke, stream)
- ✅ Mock LLM responses as simple return values
- ✅ spanKind: 'workflow' or 'agent'
- ✅ Test orchestration logic, not API calls
- ✅ `beforeEach()` for fresh module state per test

### LLM_CLIENT (openai, anthropic, google-genai)

**FORBIDDEN:**
- ❌ Pure function tests without VCR
- ❌ spanKind: 'workflow' (use 'llm' instead)

**REQUIRED:**
- ✅ `withVersions()` wrapper (required for orchestrion rewriter — no exceptions)
- ✅ VCR cassettes with proxy baseURL
- ✅ Real API calls (recorded once)
- ✅ spanKind: 'llm'
- ✅ modelName, modelProvider fields

### MULTI_PROVIDER (ai-sdk, langchain)

Same as LLM_CLIENT.

### TOOL_CLIENT (modelcontextprotocol-sdk)

**FORBIDDEN:**
- ❌ VCR cassettes (tool protocol clients use mock servers, not recorded HTTP)
- ❌ spanKind: 'llm' (use 'tool' or 'retrieval')
- ❌ modelName, modelProvider fields (not an LLM API)
- ❌ Module require outside `withVersions()` callback

**REQUIRED:**
- ✅ `withVersions()` wrapper (required for orchestrion rewriter — no exceptions)
- ✅ In-process mock server (e.g., MCP `InMemoryTransport`) — no external services
- ✅ Load all submodules via versioned require inside `withVersions()` callback
- ✅ spanKind: 'tool' or 'retrieval'
- ✅ Validate protocol-specific metadata (tool names, server names, resource URIs)
- ✅ `before()` / `after()` for server setup/teardown

### INFRASTRUCTURE (generic protocol packages with no LLMObs operations)

**REQUIRED:**
- ✅ Mock server tests
- ❌ NO VCR

---

## Overview

Test strategy depends on package category:

| LlmObsCategory | VCR | Real APIs | Mock Server | withVersions | Strategy |
|----------------|-----|-----------|-------------|--------------|----------|
| LLM_CLIENT | ✅ Yes | ✅ Yes | ❌ No | ✅ Required | VCR with real API calls |
| MULTI_PROVIDER | ✅ Yes | ✅ Yes | ❌ No | ✅ Required | VCR with real API calls |
| ORCHESTRATION | ❌ No | ❌ No | ❌ No | ✅ Required | Pure functions, mock responses |
| TOOL_CLIENT | ❌ No | ❌ No | ✅ Yes | ✅ Required | In-process mock server |
| INFRASTRUCTURE | ❌ No | ❌ No | ✅ Yes | ✅ Required | Mock servers |

**Enum location:** `anubis_apm/workflows/analyze/models.py`

**`withVersions()` is required for ALL categories.** It configures `NODE_PATH` for the orchestrion rewriter. Without it, no APM spans are produced regardless of category.

**IF YOU USE THE WRONG STRATEGY, THE TEST WILL FAIL. ALWAYS CHECK THE CATEGORY FIRST.**

## LlmObsCategory.LLM_CLIENT & LlmObsCategory.MULTI_PROVIDER

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

  const events = getEvents()

  assertLlmObsSpanEvent(events[0], {
    spanKind: 'llm',
    modelName: 'gpt-4',
    inputMessages: [{ content: 'Hello', role: 'user' }],
    outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
    metrics: { input_tokens: MOCK_NOT_NULLISH }
  })
})
```

### Key Points

- ✅ Use VCR proxy URL
- ✅ Make real API calls
- ✅ Test actual LLM responses
- ✅ Validate token counts from real usage
- ✅ Test provider-specific features
- ✅ Commit cassettes to repo

### ⚠️ Transitive Dependency Require Order

If the instrumented methods live in a **sub-package** that is a dependency of the package you load (e.g. `@openai/agents-openai` is a dep of `@openai/agents-core`), you must **require the sub-package first**.

RITM patches modules on their first `require()`. If the parent package loads the sub-package transitively before your `before()` hook requires it, the module is already cached and RITM never fires — instrumentation silently does nothing.

```javascript
before(() => {
  // ✅ CORRECT: require the instrumented sub-package first
  const { OpenAIResponsesModel } = require('@openai/agents-openai')
  const agentsCore = require('@openai/agents-core')

  // ❌ WRONG: parent loads sub-package transitively, caching it before RITM patches it
  // const agentsCore = require('@openai/agents-core')        // caches @openai/agents-openai
  // const { OpenAIResponsesModel } = require('@openai/agents-openai')  // already cached, not patched
})
```

**Symptom when wrong:** tests time out — `getEvents()` never resolves, no APM traces arrive, only the SDK's own internal tracing output appears.

## LlmObsCategory.ORCHESTRATION

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

  const events = getEvents()

  assertLlmObsSpanEvent(events[0], {
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

Orchestration tools don't make HTTP calls themselves - they coordinate other libraries that do. Testing them requires testing the orchestration logic, not API interactions.

## LlmObsCategory.TOOL_CLIENT (e.g., modelcontextprotocol-sdk)

**Strategy:** In-process mock server with `withVersions()` + versioned submodule requires

### Setup

MCP SDK uses `InMemoryTransport` — no external server process needed. All submodules must be loaded via `require(...versions/...).get(subpath)` **inside** the `withVersions()` callback.

```javascript
withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', (version) => {
  let Client, Server, InMemoryTransport, CallToolRequestSchema
  let client, server

  before(async () => {
    // Load each submodule via the versioned require path
    Client = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
      .get('@modelcontextprotocol/sdk/client').Client
    Server = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
      .get('@modelcontextprotocol/sdk/server').Server
    InMemoryTransport = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
      .get('@modelcontextprotocol/sdk/inMemory.js').InMemoryTransport
    CallToolRequestSchema = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
      .get('@modelcontextprotocol/sdk/types.js').CallToolRequestSchema

    server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } })

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return { content: [{ type: 'text', text: `Result from ${request.params.name}` }] }
    })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(clientTransport)
  })

  after(async () => {
    await client?.close()
    await server?.close()
  })

  // tests here
})
```

### Test Pattern

```javascript
it('creates a tool span for a tool call', async () => {
  const result = await client.callTool({ name: 'my-tool', arguments: { key: 'value' } })

  assert.ok(result.content)

  const { apmSpans, llmobsSpans } = await getEvents()

  assertLlmObsSpanEvent(llmobsSpans[0], {
    span: apmSpans[0],
    spanKind: 'tool',
    name: 'mcp.tool.my-tool',
    inputValue: JSON.stringify({ name: 'my-tool', arguments: { key: 'value' } }),
    outputValue: 'Result from my-tool',
    metadata: {
      'mcp.tool.name': 'my-tool',
      'mcp.server.name': 'test-server',
    },
  })
})
```

### Key Points

- ✅ `withVersions()` wraps all setup and tests
- ✅ All submodule requires use versioned path inside `withVersions` callback
- ✅ `InMemoryTransport.createLinkedPair()` for in-process client/server
- ✅ spanKind: 'tool' (not 'llm')
- ✅ Validate `mcp.tool.name` and `mcp.server.name` in metadata
- ❌ NO VCR
- ❌ NO external server processes

### Common TOOL_CLIENT Mistake: Submodule Require Order

If the MCP SDK client and server share internal modules, require the client submodule first so RITM patches it before the server loads it transitively:

```javascript
// ✅ Require client first so RITM patches it before server loads it
Client = require(`.../@modelcontextprotocol/sdk@${version}`).get('@modelcontextprotocol/sdk/client').Client
Server = require(`.../@modelcontextprotocol/sdk@${version}`).get('@modelcontextprotocol/sdk/server').Server
```

## Category 5: Infrastructure

**Strategy:** Mock server tests (for packages that implement protocols but have no LLMObs operations)

### Setup

```javascript
withVersions('my-protocol', 'my-protocol-pkg', (version) => {
  let client, server

  before(async () => {
    const { Server, Client } = require(`../../../../../../versions/my-protocol-pkg@${version}`).get()
    server = new Server()
    await server.start()
    client = new Client({ url: server.url })
  })

  after(async () => server?.stop())

  // tests here
})
```

### Key Points

- ✅ `withVersions()` required
- ✅ Mock server instances
- ✅ Test protocol compliance
- ❌ NO VCR

## Decision Matrix

Use this to choose strategy:

### Does package make HTTP calls to LLM APIs?

**YES** → Use VCR (LLM_CLIENT or MULTI_PROVIDER)
- `withVersions()` + configure baseURL to VCR proxy
- Make real API calls (recorded once)
- Validate real responses

**NO** → Check next question

### Does it orchestrate workflows/graphs?

**YES** → Pure functions (ORCHESTRATION)
- `withVersions()` + no VCR proxy
- Mock LLM responses as simple return values
- Test state management

**NO** → Check next question

### Does it implement a tool/resource protocol (e.g., MCP)?

**YES** → In-process mock server (TOOL_CLIENT)
- `withVersions()` + `InMemoryTransport` or equivalent
- Test protocol execution (tool calls, resource reads)
- spanKind: 'tool' or 'retrieval'

**NO** → Generic mock server (INFRASTRUCTURE)
- `withVersions()` + mock server instance
- Test protocol/transport compliance

## Common Mistakes

### Mistake 1: Missing `withVersions()` → silent timeouts (ALL categories)

```javascript
// ❌ WRONG - no withVersions, orchestrion can't instrument the module
before(async () => {
  const mod = require('../../../../../../versions/@modelcontextprotocol/sdk@>=1.27.1')
    .get('@modelcontextprotocol/sdk/client')
  Client = mod.Client
})
```

**Why wrong:** Without `withVersions()`, `NODE_PATH` is never updated and the orchestrion rewriter can't find the module. No APM spans are produced, `getEvents()` hangs forever, and all tests timeout with no useful error.

**Fix:** Wrap everything in `withVersions()` and use the `version` parameter in the require path.

```javascript
// ✅ CORRECT
withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', (version) => {
  before(async () => {
    Client = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
      .get('@modelcontextprotocol/sdk/client').Client
  })
})
```

### Mistake 2: Using VCR for Orchestration or Tool Clients

```javascript
// ❌ WRONG - LangGraph with VCR
const client = new StateGraph({ baseURL: 'http://127.0.0.1:9126/vcr/langgraph' })
```

**Why wrong:** Orchestration and tool-client libraries don't make HTTP calls themselves.

**Fix:** Use pure functions (orchestration) or `InMemoryTransport` (tool clients).

### Mistake 3: Not Using VCR for LLM API Clients

```javascript
// ❌ WRONG - OpenAI without VCR
const client = new OpenAI({ apiKey: 'real-key', baseURL: 'https://api.openai.com' })
```

**Why wrong:** Tests will fail without API key, hit rate limits, be non-deterministic.

**Fix:** Use VCR proxy URL.

### Mistake 4: Making Real API Calls in Orchestration Tests

```javascript
// ❌ WRONG - Real OpenAI in LangGraph test
graph.addNode('agent', async (state) => {
  const openai = new OpenAI({ apiKey: 'real-key' })
  return await openai.chat.completions.create({ ... })
})
```

**Why wrong:** Orchestration tests should be pure functions.

**Fix:** Mock LLM responses as simple return values.

## Examples by Category

### LLM_CLIENT: Anthropic (withVersions + VCR)

```javascript
withVersions('anthropic', '@anthropic-ai/sdk', (version) => {
  before(() => {
    const { Anthropic } = require(`../../../../../../versions/@anthropic-ai/sdk@${version}`).get()
    client = new Anthropic({ baseURL: 'http://127.0.0.1:9126/vcr/anthropic' })
  })
})
```

### MULTI_PROVIDER: Vercel AI SDK (withVersions + VCR)

```javascript
withVersions('ai', 'ai', (version) => {
  before(() => {
    const { generateText } = require(`../../../../../../versions/ai@${version}`).get()
    // use VCR-backed model
  })
})
```

### ORCHESTRATION: LangGraph (withVersions + pure functions)

```javascript
withVersions('langgraph', '@langchain/langgraph', (version) => {
  beforeEach(() => {
    const { StateGraph, Annotation } = require(`../../../../../../versions/@langchain/langgraph@${version}`).get()
    // build graph with mock node responses
  })
})
```

### TOOL_CLIENT: MCP SDK (withVersions + InMemoryTransport)

```javascript
withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', (version) => {
  before(async () => {
    Client = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
      .get('@modelcontextprotocol/sdk/client').Client
    Server = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
      .get('@modelcontextprotocol/sdk/server').Server
    InMemoryTransport = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
      .get('@modelcontextprotocol/sdk/inMemory.js').InMemoryTransport

    server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(ct)
  })
})
```

## Summary

- **LLM_CLIENT / MULTI_PROVIDER**: `withVersions()` + VCR, test real API calls
- **ORCHESTRATION**: `withVersions()` + pure functions, mock LLM responses
- **TOOL_CLIENT**: `withVersions()` + `InMemoryTransport`, test tool execution
- **INFRASTRUCTURE**: `withVersions()` + mock server, test protocol compliance
- **ALL categories**: `withVersions()` is mandatory — without it, no spans are produced

Choose strategy based on what the package does, not what it's called.
