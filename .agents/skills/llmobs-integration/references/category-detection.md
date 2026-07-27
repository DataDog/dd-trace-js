# Package Category Detection Reference

Detailed guide for classifying an LLM package into one of the four shapes. These are working categories
for reasoning about a package, not constants in the codebase.

## Categories Explained

### LLM client

**Definition:** Direct wrappers around LLM provider APIs.

**Examples:**
- `@google/genai` - Google GenAI client (recommended reference implementation)
- `@anthropic-ai/sdk` - Anthropic Claude client (recommended reference implementation)
- `openai` - OpenAI API client

**Observable signs:**
- Package name contains provider name (openai, anthropic, genai, etc.)
- Has chat/completion/embedding methods (`chat.completions.create`, `messages.create`)
- Makes HTTP calls directly to LLM provider endpoints
- Requires API keys for authentication
- Has HTTP client dependencies (axios, fetch, request)
- Code contains HTTP request patterns

**Test strategy:** VCR with real API calls via proxy

### Multi-provider

**Definition:** Unified interfaces that abstract multiple LLM providers.

**Examples:**
- `ai` - Vercel AI SDK
- `langchain` - LangChain framework

**Observable signs:**
- Package name suggests multi-provider (ai, langchain)
- Provider configuration and switching support
- Wraps multiple LLM client libraries
- Dependencies include 2+ LLM provider SDKs
- Has abstraction layers over providers

**Test strategy:** VCR with real API calls via proxy

### Orchestration

**Definition:** Workflow/graph managers that coordinate LLM calls but don't make them directly.

**Examples:**
- `@langchain/langgraph` - LangGraph workflow engine
- Workflow engines, agent coordinators

**Observable signs:**
- Package name suggests orchestration (langgraph, crew, workflow, graph)
- Has graph/workflow/chain execution methods (`invoke`, `stream`, `run`)
- Manages state and control flow between nodes/agents
- Dependencies include orchestration libraries (e.g., @langchain/core)
- Methods focus on state management, not API calls

**Test strategy:** Pure function tests, NO VCR, NO real API calls

### Infrastructure

**Definition:** Communication protocols, server frameworks, infrastructure layers.

**Examples:**
- MCP (Model Context Protocol) clients/servers
- Protocol implementations
- Transport layers

**Observable signs:**
- Package name suggests infrastructure (mcp, protocol, server, transport)
- Implements protocols or server/client architecture
- Transport layer code

**Test strategy:** Mock server tests

## Decision Tree

Follow this tree to determine category:

```
1. Does the package make direct HTTP calls to LLM provider endpoints?
    ├─ YES → Go to question 2
    └─ NO  → Go to question 3

2. Does it support multiple LLM providers via configuration?
    ├─ YES → multi-provider
    └─ NO  → LLM client

3. Does it implement workflow/graph orchestration with state management?
    ├─ YES → orchestration
    └─ NO  → infrastructure
```

## Detection Process

### Step 1: Read Package Name

Analyze package name for patterns:
- Contains "openai", "anthropic", "genai" → Likely LLM client
- Named `ai`, or contains "langchain" or "llamaindex" → Likely multi-provider
- Contains "langgraph", "crew", "workflow" → Likely orchestration
- Contains "mcp", "protocol", "server" → Likely infrastructure

"ai" only counts as an exact package name. Every provider client contains it as a substring.

### Step 2: Check package.json Dependencies

```bash
cat node_modules/{{package}}/package.json
```

Look for:
- HTTP clients (axios, fetch, got) → LLM client
- Multiple LLM SDKs (openai + anthropic + cohere) → multi-provider
- LangChain/orchestration libs → orchestration
- Protocol/transport libs → infrastructure

### Step 3: Check Exported Methods

```bash
node -e "console.log(Object.keys(require('{{package}}')))"
```

Method patterns:
- `chat()`, `complete()`, `embed()` → LLM client or multi-provider
- `invoke()`, `stream()`, `graph()`, `workflow()` → orchestration
- `connect()`, `listen()`, `handle()` → infrastructure

### Step 4: Analyze Source Code

Check for:
- HTTP request patterns (`http.request`, `.post(`, `fetch(`) → LLM client
- Provider switching logic → multi-provider
- State management, graph execution → orchestration
- Protocol implementation → infrastructure

## Real-World Examples

### Example 1: Anthropic (LLM client)

**Package:** `@anthropic-ai/sdk` — see `packages/datadog-plugin-anthropic/`

**Category:** LLM client — name contains "anthropic", direct HTTP calls to Claude API, requires API key, methods are
`messages.create`

### Example 2: Google GenAI (LLM client)

**Package:** `@google/genai` — see `packages/datadog-plugin-google-genai/`

**Category:** LLM client — name contains "genai", direct HTTP calls to Gemini API, complex nested message format
(contents/parts)

### Example 3: Vercel AI SDK (multi-provider)

**Package:** `ai` (Vercel AI SDK)

- Named `ai`, not a provider name
- Depends on openai + anthropic SDKs (multiple LLM providers)
- Methods include provider-agnostic chat interface

**Category:** multi-provider

### Example 4: LangGraph (orchestration)

**Package:** `@langchain/langgraph` — see `packages/dd-trace/src/llmobs/plugins/langgraph/`

**Category:** orchestration — name indicates graph orchestration, depends on `@langchain/core`, methods manage
workflow state (`StateGraph.invoke`, `Pregel.stream`), no direct LLM HTTP calls

## Edge Cases

When signals conflict or are weak, choose the category with the most evidence and prefer the category that matches
test strategy needs: if the package makes HTTP calls it needs VCR (LLM client/multi-provider); if it doesn't, use pure
functions (orchestration) or mock servers (infrastructure).

Some packages don't fit cleanly:
- Utilities/helpers → Check what they instrument
- Plugins/extensions → Follow parent library category
- Hybrid packages → Categorize by primary function
