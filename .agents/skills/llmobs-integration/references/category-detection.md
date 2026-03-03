# Package Category Detection Reference

Detailed guide for classifying LLM packages into `LlmObsCategory` enum values.

**Enum location:** `anubis_apm/workflows/analyze/models.py`

## Categories Explained

### LlmObsCategory.LLM_CLIENT

**Definition:** Direct wrappers around LLM provider APIs.

**Examples:**
- `openai` - OpenAI API client
- `@google/generative-ai` - Google GenAI client
- `@anthropic-ai/sdk` - Anthropic Claude client
- `@mistralai/mistralai` - Mistral AI client
- `cohere-ai` - Cohere API client

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
- `llamaindex` - LlamaIndex framework

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
- `crewai` - CrewAI multi-agent framework
- Workflow engines, agent coordinators

**Observable signs:**
- Package name suggests orchestration (langgraph, crew, workflow, graph)
- Has graph/workflow/chain execution methods (`invoke`, `stream`, `run`)
- Manages state and control flow between nodes/agents
- Does NOT make HTTP calls to LLM providers
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
- Contains "openai", "anthropic", "genai", "cohere" → Likely `LlmObsCategory.LLM_CLIENT`
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

## Multi-Signal Heuristics

When category is uncertain, use scoring heuristics:

### Signal 1: Package Name Patterns (weight: 3)

```python
if name contains ['openai', 'anthropic', 'genai', 'mistral']:
    llm_client += 3

if name contains ['langchain', 'llamaindex', 'ai-sdk']:
    multi_provider += 3

if name contains ['langgraph', 'crew', 'workflow', 'graph']:
    orchestration += 3

if name contains ['mcp', 'protocol', 'server']:
    infrastructure += 3
```

### Signal 2: Dependencies (weight: 2)

```python
if depends on ['axios', 'fetch', 'got', 'request']:
    llm_client += 2

if depends on ['langchain', '@langchain/core']:
    orchestration += 2

if depends on 2+ provider SDKs:
    multi_provider += 2
```

### Signal 3: Method Patterns (weight: 1-2)

```python
if methods include ['chat', 'completion', 'generate', 'embed']:
    llm_client += 1
    multi_provider += 1

if methods include ['graph', 'workflow', 'state', 'invoke']:
    orchestration += 2
```

### Signal 4: HTTP Code (weight: 1)

```python
if plugin includes HTTP requests:
    llm_client += 1
```

### Confidence Levels

- **High confidence:** Score >= 5, clear signals
- **Medium confidence:** Score 3-4, some signals
- **Low confidence:** Score < 3, weak or no signals

## Real-World Examples

### Example 1: OpenAI (Category 1)

**Package:** `openai`

**Analysis:**
- Name contains "openai" → +3 llm_client
- Has axios dependency → +2 llm_client
- Methods: `chat.completions.create` → +1 llm_client
- Plugin includes HTTP requests → +1 llm_client
- **Total score:** 7 (high confidence)

**Category:** llm_client
**Confidence:** high
**Reasoning:** Package name indicates LLM client, has HTTP client dependencies, methods are chat/completion API calls

### Example 2: LangGraph (Category 3)

**Package:** `@langchain/langgraph`

**Analysis:**
- Name contains "langgraph" → +3 orchestration
- Depends on @langchain/core → +2 orchestration
- Methods: `StateGraph.invoke`, `CompiledStateGraph.stream` → +2 orchestration
- No HTTP client dependencies → 0 llm_client
- **Total score:** 7 (high confidence)

**Category:** orchestration
**Confidence:** high
**Reasoning:** Package name indicates orchestration, depends on LangChain, methods focus on graph execution and state management

### Example 3: Vercel AI SDK (Category 2)

**Package:** `@ai-sdk/vercel`

**Analysis:**
- Name contains "ai-sdk" → +3 multi_provider
- Depends on openai + anthropic SDKs → +2 multi_provider
- Methods include provider-agnostic chat → +1 multi_provider
- **Total score:** 6 (high confidence)

**Category:** multi_provider
**Confidence:** high
**Reasoning:** SDK name suggests abstraction, depends on multiple LLM providers, provides unified interface

## Output Format

Always return:
- `package_category`: One of `llm_client`, `multi_provider`, `orchestration`, `infrastructure`
- `category_confidence`: One of `high`, `medium`, `low`
- `category_reasoning`: Detailed explanation with evidence

**Example output:**

```json
{
  "package_category": "orchestration",
  "category_confidence": "high",
  "category_reasoning": "Package name '@langchain/langgraph' clearly indicates orchestration. Dependencies include @langchain/core (orchestration framework) but no HTTP clients or LLM provider SDKs. Exported classes StateGraph and Pregel with invoke/stream methods manage workflow execution and state transitions rather than making direct LLM API calls. Heuristic score: 7."
}
```

## Edge Cases

### Uncertain Cases

When signals conflict or are weak:
- Document all signals found
- Choose category with highest score
- Set confidence to "low"
- Explain uncertainty in reasoning

### Non-Standard Packages

Some packages don't fit cleanly:
- Utilities/helpers → Check what they instrument
- Plugins/extensions → Follow parent library category
- Hybrid packages → Categorize by primary function

**Guideline:** When in doubt, prefer category that matches test strategy needs. If package makes HTTP calls, it needs VCR (Category 1/2). If it doesn't, use pure functions (Category 3).
