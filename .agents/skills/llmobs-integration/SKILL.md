---
name: llmobs-integration
description: |
  Use when adding, debugging, or modifying LLMObs plugins for an LLM library
  in dd-trace-js. Triggers: "add LLMObs support", "instrument chat
  completions / streaming / embeddings / agent runs / orchestration / tool
  calls / retrieval", "LLMObsPlugin", "getLLMObsSpanRegisterOptions",
  "setLLMObsTags", "LlmObsCategory", "LlmObsSpanKind", any provider tag
  ("openai" / "anthropic" / "genai" / "google" / "langchain" / "langgraph" /
  "ai-sdk" llmobs), "VCR cassettes".
---

# LLM Observability Integration Skill

This skill covers creating LLMObs plugins that instrument LLM library operations and emit span events. Supported operations: chat completions (streaming and non-streaming), embeddings, agent runs, orchestration (workflows / graphs), tool calls, retrieval (RAG / vector DB).

## Core Concepts

### 1. LLMObsPlugin Base Class

All LLMObs plugins extend `LLMObsPlugin`. Two methods must be implemented:

- `getLLMObsSpanRegisterOptions(ctx)` — returns `{ modelProvider, modelName, kind, name }`.
- `setLLMObsTags(ctx)` — extracts and tags input / output messages, token metrics, and model metadata.

Lifecycle: `start(ctx)` registers the span and captures context; the wrapped operation runs; `asyncEnd(ctx)` calls `setLLMObsTags()`; `end(ctx)` restores the parent.

See [references/plugin-architecture.md](references/plugin-architecture.md) for the full implementation surface.

### 2. Package Category System

**CRITICAL:** Every integration must be classified into one category using the `LlmObsCategory` enum. This determines test strategy and implementation approach.

#### LlmObsCategory Enum Values

- **`LlmObsCategory.LLM_CLIENT`** - Direct API wrappers (openai, anthropic, genai)
  - Signs: Makes HTTP calls to LLM provider endpoints, requires API keys
  - Test strategy: VCR with real API calls via proxy
  - Instrumentation: Hook chat/completion methods

- **`LlmObsCategory.MULTI_PROVIDER`** - Multi-provider frameworks (ai-sdk, langchain)
  - Signs: Supports multiple LLM providers via configuration, wraps LLM_CLIENT libraries
  - Test strategy: VCR with real API calls via proxy
  - Instrumentation: Hook provider abstraction layer

- **`LlmObsCategory.ORCHESTRATION`** - Workflow managers (langgraph)
  - Signs: Graph/workflow execution, state management, NO direct HTTP to LLM providers
  - Test strategy: Pure function tests, NO VCR, NO real API calls
  - Instrumentation: Hook workflow lifecycle (invoke, stream, run)
  - **Special:** Tests should use actual LLM as orchestration node (not mock responses)

- **`LlmObsCategory.INFRASTRUCTURE`** - Protocols/servers (MCP)
  - Signs: Protocol implementation, server/client architecture, transport layers
  - Test strategy: Mock server tests
  - Instrumentation: Hook protocol handlers

#### Decision Tree

Answer these questions by reading the code:

1. **Does the package make direct HTTP calls to LLM provider endpoints?**
   - YES → Go to question 2
   - NO → Go to question 3

2. **Does it support multiple LLM providers via configuration?**
   - YES → **`LlmObsCategory.MULTI_PROVIDER`**
   - NO → **`LlmObsCategory.LLM_CLIENT`**

3. **Does it implement workflow/graph orchestration with state management?**
   - YES → **`LlmObsCategory.ORCHESTRATION`**
   - NO → **`LlmObsCategory.INFRASTRUCTURE`**

See [references/category-detection.md](references/category-detection.md) for detailed heuristics and examples.

### 3. LLM Span Kinds

Use the `LlmObsSpanKind` enum:

- **`LlmObsSpanKind.LLM`** - Chat completions, text generation
- **`LlmObsSpanKind.WORKFLOW`** - Graph/chain execution
- **`LlmObsSpanKind.AGENT`** - Agent runs
- **`LlmObsSpanKind.TOOL`** - Tool/function calls
- **`LlmObsSpanKind.EMBEDDING`** - Embedding generation
- **`LlmObsSpanKind.RETRIEVAL`** - Vector DB/RAG retrieval

**Most common:** Use `'llm'` for chat completions/text generation in LLM_CLIENT and MULTI_PROVIDER categories.

### 4. Message Extraction

All plugins must convert provider-specific message formats to the standard format:

**Standard format:** `[{content: string, role: string}]`

**Common roles:** `'user'`, `'assistant'`, `'system'`, `'tool'`

**Provider-specific handling:**
- OpenAI: Direct format match, handle `function_call` and `tool_calls`
- Anthropic: Map `role` values, flatten nested content arrays
- Google GenAI: Extract from `parts` arrays, map role names
- Multi-provider: Detect provider and apply appropriate extraction

See [references/message-extraction.md](references/message-extraction.md) for provider-specific patterns.

## Implementation Steps

1. **Detect package category** (REQUIRED FIRST STEP)
   - Follow decision tree above
   - Output: category, confidence, reasoning

2. **Create plugin file**
   - Location: `packages/dd-trace/src/llmobs/plugins/{integration}/index.js`
   - Extend: `LLMObsPlugin` base class
   - Implement: Required methods per plugin architecture

3. **Implement `getLLMObsSpanRegisterOptions(ctx)`**
   - Extract model provider and name from context
   - Determine span kind (usually `'llm'`)
   - Return registration options object

4. **Implement `setLLMObsTags(ctx)`**
   - Extract input messages from `ctx.arguments`
   - Extract output messages from `ctx.result`
   - Extract token metrics (input_tokens, output_tokens, total_tokens)
   - Extract metadata (temperature, max_tokens, etc.)
   - Tag span using `this._tagger` methods

5. **Handle edge cases**
   - Streaming responses (if applicable)
   - Error cases (empty output messages)
   - Non-standard message formats
   - Missing metadata

See [references/plugin-architecture.md](references/plugin-architecture.md) for step-by-step implementation guide.

## Plugin Registration

All plugins must export an array:

**Static properties required:**
- `integration` - Integration name (e.g., 'openai')
- `id` - Unique plugin ID (e.g., 'llmobs_openai')
- `prefix` - Channel prefix (e.g., 'tracing:apm:openai:chat')

## References

For detailed information, see:

- [references/plugin-architecture.md](references/plugin-architecture.md) - Complete plugin structure, implementation steps, helper methods
- [references/category-detection.md](references/category-detection.md) - Package classification heuristics and detection process
- [references/message-extraction.md](references/message-extraction.md) - Provider-specific message format patterns
- [references/reference-implementations.md](references/reference-implementations.md) - Working plugin examples (Anthropic, Google GenAI)
