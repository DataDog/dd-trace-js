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
- ✅ Pure function tests using library's native APIs (StateGraph, invoke, stream)
- ✅ Mock LLM responses as simple return values
- ✅ spanKind: 'workflow' or 'agent'
- ✅ Test orchestration logic, not API calls

### LLM_CLIENT (openai, anthropic, google-genai)

**FORBIDDEN:**
- ❌ Pure function tests without VCR
- ❌ spanKind: 'workflow' (use 'llm' instead)

**REQUIRED:**
- ✅ VCR cassettes with proxy baseURL
- ✅ Real API calls (recorded once)
- ✅ spanKind: 'llm'
- ✅ modelName, modelProvider fields

### MULTI_PROVIDER (ai-sdk, langchain)

Same as LLM_CLIENT.

### INFRASTRUCTURE (MCP)

**REQUIRED:**
- ✅ Mock server tests
- ❌ NO VCR

---

## Overview

Test strategy depends on package category:

| LlmObsCategory | VCR | Real APIs | Mock LLMs | Strategy |
|----------------|-----|-----------|-----------|----------|
| LLM_CLIENT | ✅ Yes | ✅ Yes | ❌ No | VCR with real API calls |
| MULTI_PROVIDER | ✅ Yes | ✅ Yes | ❌ No | VCR with real API calls |
| ORCHESTRATION | ❌ No | ❌ No | ✅ Yes | Pure functions, mock responses |
| INFRASTRUCTURE | ❌ No | ❌ No | ✅ Yes | Mock servers |

**Enum location:** `anubis_apm/workflows/analyze/models.py`

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

## Category 4: Infrastructure

**Strategy:** Mock server tests

### Setup

```javascript
const mockServer = new MockMCPServer()
await mockServer.start()
```

### Test Pattern

```javascript
it('instruments MCP protocol', async () => {
  const client = new MCPClient({
    serverUrl: mockServer.url
  })

  await client.connect()
  const response = await client.call('method', params)

  const events = getEvents()

  assertLlmObsSpanEvent(events[0], {
    spanKind: 'task',  // Or appropriate kind
    name: 'mcp.call'
  })
})
```

### Key Points

- ❌ NO VCR
- ✅ Mock server instances
- ✅ Test protocol compliance
- ✅ Test message passing
- ✅ Validate transport behavior

## Decision Matrix

Use this to choose strategy:

### Does package make HTTP calls to LLM APIs?

**YES** → Use VCR (Category 1 or 2)
- Configure baseURL to VCR proxy
- Make real API calls
- Validate real responses

**NO** → Check next question

### Does it orchestrate workflows/graphs?

**YES** → Pure functions (Category 3)
- No VCR proxy
- Mock LLM responses
- Test state management

**NO** → Mock servers (Category 4)
- Create mock server
- Test protocol/transport

## Common Mistakes

### Mistake 1: Using VCR for Orchestration

```javascript
// ❌ WRONG - LangGraph with VCR
const client = new StateGraph({
  baseURL: 'http://127.0.0.1:9126/vcr/langgraph'
})
```

**Why wrong:** LangGraph doesn't make HTTP calls itself.

**Fix:** Use pure functions with mock responses.

### Mistake 2: Not Using VCR for API Clients

```javascript
// ❌ WRONG - OpenAI without VCR
const client = new OpenAI({
  apiKey: 'real-key',
  baseURL: 'https://api.openai.com'  // Direct to API
})
```

**Why wrong:** Tests will fail without API key, hit rate limits, be non-deterministic.

**Fix:** Use VCR proxy URL.

### Mistake 3: Making Real API Calls in Orchestration Tests

```javascript
// ❌ WRONG - Real OpenAI in LangGraph test
graph.addNode('agent', async (state) => {
  const openai = new OpenAI({ apiKey: 'real-key' })
  return await openai.chat.completions.create({ ... })
})
```

**Why wrong:** Orchestration tests should be pure functions.

**Fix:** Mock LLM responses directly.

## Examples by Category

### Category 1: OpenAI (VCR)

```javascript
const openai = new OpenAI({
  apiKey: 'test',
  baseURL: 'http://127.0.0.1:9126/vcr/openai'
})
await openai.chat.completions.create({ ... })
```

### Category 2: Vercel AI SDK (VCR)

```javascript
const model = createOpenAI({
  apiKey: 'test',
  baseURL: 'http://127.0.0.1:9126/vcr/openai'
})
await generateText({ model, prompt: '...' })
```

### Category 3: LangGraph (Pure Functions)

```javascript
graph.addNode('agent', async (state) => ({
  messages: [{ role: 'assistant', content: 'Mock' }]
}))
await graph.invoke({ ... })
```

### Category 4: MCP (Mock Server)

```javascript
const mockServer = new MockServer()
const client = new MCPClient({ url: mockServer.url })
await client.call('method', {})
```

## Summary

- **API clients**: Use VCR, test real APIs
- **Multi-provider**: Use VCR, test provider switching
- **Orchestration**: Pure functions, mock responses
- **Infrastructure**: Mock servers, test protocols

Choose strategy based on what the package does, not what it's called.
