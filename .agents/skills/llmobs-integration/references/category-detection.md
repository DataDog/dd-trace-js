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

**Test strategy:** the SDK's own server and client over its in-memory transport

## Detection Process

Direct HTTP calls to provider endpoints mean LLM client, or multi-provider when the provider is
configurable. Without them, graph or workflow execution means orchestration and a protocol
implementation means infrastructure.

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

## Worked Examples

| Package | Category | Deciding signal |
|---------|----------|-----------------|
| `@anthropic-ai/sdk` | LLM client | `messages.create` calls the Claude API directly, needs a key |
| `@google/genai` | LLM client | calls the Gemini API directly, nested `contents` / `parts` format |
| `ai` | multi-provider | not a provider name, and depends on the openai and anthropic SDKs |
| `@langchain/langgraph` | orchestration | `StateGraph.invoke` / `Pregel.stream` manage state, no provider calls |

## Edge Cases

When signals conflict or are weak, choose the category with the most evidence and prefer the category that matches
test strategy needs: if the package makes HTTP calls it needs VCR (LLM client/multi-provider); if it doesn't, use pure
functions (orchestration) or the SDK's in-memory transport (infrastructure).

Some packages don't fit cleanly:
- Utilities/helpers → Check what they instrument
- Plugins/extensions → Follow parent library category
- Hybrid packages → Categorize by primary function
