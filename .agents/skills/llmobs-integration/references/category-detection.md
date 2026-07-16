# Package Category Detection Reference

Detailed guide for classifying LLM packages into `LlmObsCategory` enum values.

## Categories Explained

### LlmObsCategory.LLM_CLIENT

**Definition:** Direct wrappers around LLM provider APIs.

**Examples:**
- `@google/generative-ai` - Google GenAI client (recommended reference implementation)
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

**Enum value:** `LlmObsCategory.LLM_CLIENT`

### LlmObsCategory.MULTI_PROVIDER

**Definition:** Unified interfaces that abstract multiple LLM providers.

**Examples:**
- `@ai-sdk/vercel` - Vercel AI SDK
- `langchain` - LangChain framework

**Observable signs:**
- Package name suggests multi-provider (ai-sdk, langchain)
- Provider configuration and switching support
- Wraps multiple Category 1 libraries
- Dependencies include 2+ LLM provider SDKs
- Has abstraction layers over providers

**Test strategy:** VCR with real API calls via proxy

**Enum value:** `LlmObsCategory.MULTI_PROVIDER`

### LlmObsCategory.ORCHESTRATION

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

**Enum value:** `LlmObsCategory.ORCHESTRATION`

### LlmObsCategory.INFRASTRUCTURE

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

**Enum value:** `LlmObsCategory.INFRASTRUCTURE`

## Decision Tree

Follow this tree to determine category:

```
1. Does the package make direct HTTP calls to LLM provider endpoints?
    ├─ YES → Go to question 2
    └─ NO  → Go to question 3

2. Does it support multiple LLM providers via configuration?
    ├─ YES → LlmObsCategory.MULTI_PROVIDER
    └─ NO  → LlmObsCategory.LLM_CLIENT

3. Does it implement workflow/graph orchestration with state management?
    ├─ YES → LlmObsCategory.ORCHESTRATION
    └─ NO  → LlmObsCategory.INFRASTRUCTURE
```

## Detection Process

### Step 1: Read Package Name

Analyze package name for patterns:
- Contains "openai", "anthropic", "genai" → Likely `LlmObsCategory.LLM_CLIENT`
- Contains "langchain", "llamaindex", "ai-sdk" → Likely `LlmObsCategory.MULTI_PROVIDER`
- Contains "langgraph", "crew", "workflow" → Likely `LlmObsCategory.ORCHESTRATION`
- Contains "mcp", "protocol", "server" → Likely `LlmObsCategory.INFRASTRUCTURE`

### Step 2: Check package.json Dependencies

```bash
cat node_modules/{{package}}/package.json
```

Look for:
- HTTP clients (axios, fetch, got) → `LlmObsCategory.LLM_CLIENT`
- Multiple LLM SDKs (openai + anthropic + cohere) → `LlmObsCategory.MULTI_PROVIDER`
- LangChain/orchestration libs → `LlmObsCategory.ORCHESTRATION`
- Protocol/transport libs → `LlmObsCategory.INFRASTRUCTURE`

### Step 3: Check Exported Methods

```bash
node -e "console.log(Object.keys(require('{{package}}')))"
```

Method patterns:
- `chat()`, `complete()`, `embed()` → `LlmObsCategory.LLM_CLIENT` or `MULTI_PROVIDER`
- `invoke()`, `stream()`, `graph()`, `workflow()` → `LlmObsCategory.ORCHESTRATION`
- `connect()`, `listen()`, `handle()` → `LlmObsCategory.INFRASTRUCTURE`

### Step 4: Analyze Source Code

Check for:
- HTTP request patterns (`http.request`, `.post(`, `fetch(`) → `LlmObsCategory.LLM_CLIENT`
- Provider switching logic → `LlmObsCategory.MULTI_PROVIDER`
- State management, graph execution → `LlmObsCategory.ORCHESTRATION`
- Protocol implementation → `LlmObsCategory.INFRASTRUCTURE`

## Real-World Examples

### Example 1: Anthropic (LLM_CLIENT)

**Package:** `@anthropic-ai/sdk` — see `packages/datadog-plugin-anthropic/`

**Category:** `LlmObsCategory.LLM_CLIENT` — name contains "anthropic", direct HTTP calls to Claude API, requires API key, methods are `messages.create`

### Example 2: Google GenAI (LLM_CLIENT)

**Package:** `@google/generative-ai` — see `packages/datadog-plugin-google-genai/`

**Category:** `LlmObsCategory.LLM_CLIENT` — name contains "genai", direct HTTP calls to Gemini API, complex nested message format (contents/parts)

### Example 3: Vercel AI SDK (MULTI_PROVIDER)

**Package:** `ai` (Vercel AI SDK)

- Name contains "ai-sdk" → multi_provider
- Depends on openai + anthropic SDKs (multiple LLM providers)
- Methods include provider-agnostic chat interface

**Category:** `LlmObsCategory.MULTI_PROVIDER`

### Example 4: LangGraph (ORCHESTRATION)

**Package:** `@langchain/langgraph` — see `packages/dd-trace/src/llmobs/plugins/langgraph/`

**Category:** `LlmObsCategory.ORCHESTRATION` — name indicates graph orchestration, depends on `@langchain/core`, methods manage workflow state (`StateGraph.invoke`, `Pregel.stream`), no direct LLM HTTP calls

## Edge Cases

When signals conflict or are weak, choose the category with the most evidence and prefer the category that matches test strategy needs: if the package makes HTTP calls it needs VCR (LLM_CLIENT/MULTI_PROVIDER); if it doesn't, use pure functions (ORCHESTRATION) or mock servers (INFRASTRUCTURE).

Some packages don't fit cleanly:
- Utilities/helpers → Check what they instrument
- Plugins/extensions → Follow parent library category
- Hybrid packages → Categorize by primary function
