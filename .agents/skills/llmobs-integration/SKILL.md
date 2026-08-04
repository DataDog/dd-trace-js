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

Leaf plugins extend `LLMObsPlugin` and implement two methods:

- `getLLMObsSpanRegisterOptions(ctx)` — returns a required `kind` plus any available name, model and session fields.
- `setLLMObsTags(ctx)` — tags the operation's input, output, metrics, and metadata.

A composite root such as `ai/index.js` extends `CompositePlugin` and selects leaf plugins.

On the usual promise-backed channel, `start(ctx)` registers the span and captures context, `end(ctx)` restores the
parent after the wrapped call returns, and `asyncEnd(ctx)` calls `setLLMObsTags()` after the operation settles.

See [references/plugin-architecture.md](references/plugin-architecture.md) for the full implementation surface.

### 2. Package Shape

**Settle each instrumented surface's shape before writing anything** — it decides which methods to hook and how the
operation gets its response. These are working categories for reasoning, not constants in the codebase, so classify
by reading the source rather than looking for an enum.

- **LLM client** — owns the provider endpoint, transport and authentication (openai, anthropic, genai). Hook the
  chat / completion methods.
- **Multi-provider** — accepts provider implementations behind one surface (ai, langchain). The providers may live
  in separate packages. Hook the provider abstraction layer.
- **Orchestration** — runs a graph or workflow and holds state, with no provider HTTP of its own (langgraph). Hook the
  workflow lifecycle (invoke, stream, run).
- **Infrastructure** — implements a protocol across a client / server split (modelcontextprotocol-sdk). Hook the
  protocol handlers.

The shape decides the response source and test harness. The instrumented operation decides its span kind and fields.
Hybrid packages such as `ai` and LangChain must be classified per operation. Test strategy per shape lives in
[llmobs-testing](../llmobs-testing/SKILL.md).

See [references/category-detection.md](references/category-detection.md) for heuristics and worked examples.

### 3. LLM Span Kinds

`SPAN_KINDS` in `packages/dd-trace/src/llmobs/constants/tags.js` lists `llm`, `agent`, `workflow`, `task`, `tool`,
`embedding`, `retrieval`. Chat completions and text generation are `llm`; graph or chain execution is `workflow`;
agent runs are `agent`; vector-DB and RAG lookups are `retrieval`. Only the public SDK validates against that list,
so a plugin may register a kind outside it — `ai` v7 and claude-agent-sdk both use `step`.

### 4. Message Extraction

`llm` operations convert provider-specific messages to the tagger's message shape:

**Common shape:** `[{ content?: string, role: string, toolCalls?: object[], toolResults?: object[] }]`

`role` defaults to an empty string. Tool-call or tool-result-only messages may omit `content`.

**Provider-specific handling:**
- OpenAI: Direct format match, handle `function_call` and `tool_calls`
- Anthropic: Map `role` values, flatten nested content arrays
- Google GenAI: Extract from `parts` arrays, map role names
- Multi-provider: Detect provider and apply appropriate extraction

See [references/message-extraction.md](references/message-extraction.md) for provider-specific patterns.

## Implementation Steps

1. **Map each surface's response source and operation kind**, from the upstream source rather than the package name.
2. **Create leaf plugins under `packages/dd-trace/src/llmobs/plugins/{integration}/`** extending `LLMObsPlugin`.
3. **Implement `getLLMObsSpanRegisterOptions(ctx)`** — span kind plus any available name, model and session fields.
4. **Implement `setLLMObsTags(ctx)`** — input, output, metrics and metadata from the fields the instrumentation
  publishes on `ctx`, tagged through `this._tagger`.
5. **Cover the edges**: streaming, kind-specific error output, non-standard formats, absent metadata.

Export the class itself when the package needs one plugin (openai, anthropic, genai), or an array when several
operations each need their own (langchain, langgraph, modelcontextprotocol-sdk, claude-agent-sdk). Use a
`CompositePlugin` root when one integration selects between child implementations, as `ai` does. The required static
fields and the rest of the surface are in [references/plugin-architecture.md](references/plugin-architecture.md).
