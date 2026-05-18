---
name: llmobs-integration
description: |
  This skill should be used when the user asks to "add LLMObs support", "create an LLMObs plugin",
  "instrument an LLM library", "add LLM Observability", "add llmobs", "add llm observability",
  "instrument chat completions", "instrument streaming", "instrument embeddings",
  "instrument agent runs", "instrument orchestration", "instrument LLM",
  "LLMObsPlugin", "LlmObsPlugin", "getLLMObsSpanRegisterOptions", "setLLMObsTags",
  "tagLLMIO", "tagEmbeddingIO", "tagRetrievalIO", "tagTextIO", "tagMetrics", "tagMetadata",
  "tagSpanTags", "tagPrompt", "LlmObsCategory", "LlmObsSpanKind",
  "span kind llm", "span kind workflow", "span kind agent", "span kind embedding",
  "span kind tool", "span kind retrieval",
  "openai llmobs", "anthropic llmobs", "genai llmobs", "google llmobs",
  "langchain llmobs", "langgraph llmobs", "ai-sdk llmobs",
  "llm span", "llmobs span event", "model provider", "model name",
  "CompositePlugin llmobs", "llmobs tracing", "VCR cassettes",
  or needs to build, modify, or debug an LLMObs plugin for any LLM library in dd-trace-js.
---

# LLM Observability Integration Skill

## Purpose

This skill helps you create LLMObs plugins that instrument LLM library operations and emit proper span events for LLM observability in dd-trace-js. Supported operation types include:

- **Chat completions** — standard request/response LLM calls
- **Streaming chat completions** — streamed token-by-token responses
- **Embeddings** — vector embedding generation
- **Agent runs** — autonomous LLM agent execution loops
- **Orchestration** — multi-step workflow and graph execution (langgraph, etc.)
- **Tool calls** — tool/function invocations
- **Retrieval** — vector DB / RAG operations

## When to Use

- Creating a new LLMObs plugin for an LLM library
- Adding LLMObs support to an existing tracing integration
- Understanding LLMObsPlugin architecture and patterns
- Determining how to instrument a new LLM package

## Core Concepts

### 1. LLMObsPlugin Base Class

All LLMObs plugins extend the `LLMObsPlugin` base class, which provides the core instrumentation framework.

**Key responsibilities:**
- **Span registration**: Define span metadata (model provider, model name, span kind)
- **Tag extraction**: Extract and tag LLM-specific data (messages, metrics, metadata)
- **Context management**: Handle span lifecycle and parent context

**Required methods to implement:**
- `getLLMObsSpanRegisterOptions(ctx)` - Returns span registration options (modelProvider, modelName, kind, name)
- `setLLMObsTags(ctx)` - Extracts and tags LLM data (input/output messages, metrics, metadata)

**Plugin lifecycle:**
1. `start(ctx)` - Registers span with LLMObs, captures context
2. Operation executes (chat completion call)
3. `asyncEnd(ctx)` - Calls `setLLMObsTags()` to extract and tag data
4. `end(ctx)` - Restores parent context

See [references/plugin-architecture.md](references/plugin-architecture.md) for complete implementation details.

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

## Common Patterns

Based on category:

- **LLM_CLIENT**: Messages in array, straightforward extraction from `result.choices[0]` or equivalent
- **MULTI_PROVIDER**: Handle multiple provider formats with provider detection logic
- **ORCHESTRATION**: May use `'workflow'` span kind instead of `'llm'`, focus on lifecycle events
- **INFRASTRUCTURE**: Protocol-specific instrumentation, may not have traditional messages

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

## Key Principles

1. **Category determines approach** - Always detect category first using decision tree
2. **Use enum values** - Reference `LlmObsCategory` and `LlmObsSpanKind` enums from models
3. **Standard message format** - Always convert to `[{content, role}]` format
4. **Complete metadata** - Extract all available model parameters and token metrics
5. **Error handling** - Handle failures gracefully (empty messages on error)
6. **Test strategy follows category** - VCR for clients, pure functions for orchestration
