---
name: llmobs-integration
description: |
  Use when adding, debugging, or modifying LLMObs plugins for an LLM library
  in dd-trace-js. Triggers: "add LLMObs support", "instrument chat
  completions / streaming / embeddings / agent runs / orchestration / tool
  calls / retrieval", "LLMObsPlugin", "getLLMObsSpanRegisterOptions",
  "setLLMObsTags", "SPAN_KINDS", "span kind", any provider tag
  ("openai" / "anthropic" / "genai" / "google" / "langchain" / "langgraph" /
  "ai" llmobs), "VCR cassettes".
---

# LLM Observability Integration Skill

This skill covers creating LLMObs plugins that instrument LLM library operations and emit span events. Supported
operations: chat completions (streaming and non-streaming), embeddings, agent runs, orchestration (workflows /
graphs), tool calls, retrieval (RAG / vector DB).

## Read Upstream Source First

LLM libraries iterate fast — six-month-old assumptions about an SDK's response shape, streaming contract, or tool-call
format are usually wrong. Before category detection or any plugin work, read the upstream library's source for the
installed version (`versions/<lib>@<range>/node_modules/<lib>`). The shape checklist below depends on facts the
source carries (does this package make HTTP calls? does it orchestrate? does it support multiple providers?). See
[apm-integrations § Read Upstream Source First](../apm-integrations/SKILL.md#read-upstream-source-first) for the
shallow-clone / `npm pack` shapes.

## Core Concepts

### 1. LLMObsPlugin Base Class

All LLMObs plugins extend `LLMObsPlugin`. Two methods must be implemented:

- `getLLMObsSpanRegisterOptions(ctx)` — returns `{ modelProvider, modelName, kind, name }`.
- `setLLMObsTags(ctx)` — extracts and tags input / output messages, token metrics, and model metadata.

Lifecycle: `start(ctx)` registers the span and captures context; the wrapped operation runs; `asyncEnd(ctx)` calls
`setLLMObsTags()`; `end(ctx)` restores the parent.

See [references/plugin-architecture.md](references/plugin-architecture.md) for the full implementation surface.

### 2. Package Shape

**Settle the library's shape before writing anything** — it decides which methods to hook and how the plugin can be
tested. These are working categories for reasoning about a package; none of them exists as a constant in the codebase,
so classify by reading the source rather than looking for an enum.

- **LLM client** — calls provider endpoints itself and needs API keys (openai, anthropic, genai). Hook the chat /
  completion methods.
- **Multi-provider** — exposes several providers behind one surface, wrapping the clients above (ai, langchain). Hook
  the provider abstraction layer.
- **Orchestration** — runs a graph or workflow and holds state, with no provider HTTP of its own (langgraph). Hook the
  workflow lifecycle (invoke, stream, run).
- **Infrastructure** — implements a protocol across a client / server split (modelcontextprotocol-sdk). Hook the
  protocol handlers.

The distinctions that decide it: does the package talk to a provider endpoint itself, does it front more than
one provider, and does it carry graph state. Test strategy per shape lives in
[llmobs-testing](../llmobs-testing/SKILL.md) — including that an orchestration spec drives its nodes with
plain return values, not a real model.

See [references/category-detection.md](references/category-detection.md) for heuristics and worked examples.

### 3. LLM Span Kinds

`SPAN_KINDS` in [`packages/dd-trace/src/llmobs/constants/tags.js`](../../../packages/dd-trace/src/llmobs/constants/tags.js)
lists `llm`, `agent`, `workflow`, `task`, `tool`, `embedding`, `retrieval`. Chat completions and text generation are
`llm`; graph or chain execution is `workflow`; agent runs are `agent`; vector-DB and RAG lookups are `retrieval`.
Only the public SDK validates against that list, so a plugin may register a kind outside it — `ai` v7 and
claude-agent-sdk both use `step`.

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

1. **Settle the shape first**, from the upstream source rather than the package name.
2. **Create `packages/dd-trace/src/llmobs/plugins/{integration}/index.js`** extending `LLMObsPlugin`.
3. **Implement `getLLMObsSpanRegisterOptions(ctx)`** — model provider, model name, span kind, span name.
4. **Implement `setLLMObsTags(ctx)`** — input from `ctx.arguments`, output from `ctx.result`, token metrics and
  model metadata, tagged through `this._tagger`.
5. **Cover the edges**: streaming, errors (output messages come out empty), non-standard formats, absent metadata.

Export the class itself when the package needs one plugin (openai, anthropic, genai), or an array when several
operations each need their own (langchain, langgraph, modelcontextprotocol-sdk, claude-agent-sdk). The required
static fields and the rest of the surface are in
[references/plugin-architecture.md](references/plugin-architecture.md).
