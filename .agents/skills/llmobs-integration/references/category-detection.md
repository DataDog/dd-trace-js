# Instrumented Surface Detection Reference

Detailed guide for classifying an instrumented surface by how it gets responses. These are working categories,
not constants in the codebase. The operation itself determines its span kind and fields.

## Categories Explained

### LLM client

**Definition:** Direct wrappers around LLM provider APIs.

**Examples:**
- `@google/genai` - Google GenAI client (recommended reference implementation)
- `@anthropic-ai/sdk` - Anthropic Claude client (recommended reference implementation)
- `openai` - OpenAI API client

**Observable signs:**
- Has chat/completion/embedding methods (`chat.completions.create`, `messages.create`)
- Makes HTTP calls directly to LLM provider endpoints
- Owns provider authentication and endpoint configuration
- Uses an HTTP client or the runtime's `fetch`

**Test strategy:** exercise the real client through VCR or a canned `fetch`

### Multi-provider

**Definition:** Unified interfaces that abstract multiple LLM providers.

**Examples:**
- `ai` - Vercel AI SDK
- `langchain` - LangChain framework

**Observable signs:**
- Provider configuration and switching support
- Wraps multiple LLM client libraries
- Accepts provider adapters or SDK instances, often from separate packages
- Has abstraction layers over providers

**Test strategy:** exercise the real provider path through VCR or an injected `fetch`

### Orchestration

**Definition:** Workflow/graph managers that coordinate LLM calls but don't make them directly.

**Examples:**
- `@langchain/langgraph` - LangGraph workflow engine
- Workflow engines, agent coordinators

**Observable signs:**
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
- Implements protocols or server/client architecture
- Transport layer code

**Test strategy:** the SDK's own server and client over its in-memory transport

## Detection Process

The component that performs provider HTTP determines the response strategy. A configurable provider surface is
multi-provider even when the caller supplies the provider from another package. Without provider traffic, graph or
workflow execution means orchestration and a protocol implementation means infrastructure.

### Step 1: Read the Installed Source

Inspect `versions/<package>@<range>/node_modules/<package>/` and find the exported operation being instrumented.
Follow that operation through wrappers and adapters to the code that produces its result.

### Step 2: Find the Response Owner

- Direct provider HTTP from the package → LLM client
- A caller-supplied provider adapter or model implementation → multi-provider
- Node/state execution with no provider transport → orchestration
- Client/server protocol handlers over a transport → infrastructure

### Step 3: Check Configuration and Dependencies

Use `package.json` and constructor options to confirm the source trace:
- Provider credentials, endpoints and HTTP clients support an LLM-client classification
- Provider adapter interfaces or separate provider packages support multi-provider
- State/graph dependencies support orchestration
- Protocol and transport dependencies support infrastructure

### Step 4: Use the Name Only as a Weak Signal

Names such as `openai`, `langgraph`, or `mcp` are useful search hints, not classifications. Hybrid packages and
provider adapters are classified per instrumented operation, regardless of package name.

## Worked Examples

| Package | Category | Deciding signal |
|---------|----------|-----------------|
| `@anthropic-ai/sdk` | LLM client | `messages.create` calls the Claude API directly, needs a key |
| `@google/genai` | LLM client | calls the Gemini API directly, nested `contents` / `parts` format |
| `ai` | multi-provider | accepts separately installed provider implementations behind one API |
| `@langchain/langgraph` | orchestration | `StateGraph.invoke` / `Pregel.stream` manage state, no provider calls |

## Edge Cases

When signals conflict or are weak, classify each instrumented surface by its response source. Provider-backed calls
use VCR or an injected `fetch`; orchestration uses plain node responses; infrastructure uses the SDK's in-memory
transport.

Some packages don't fit cleanly:
- Utilities/helpers → Check what they instrument
- Plugins/extensions → Follow parent library category
- Hybrid packages → Classify each instrumented operation separately
