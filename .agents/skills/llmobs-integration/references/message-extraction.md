# Message Extraction Patterns

## Overview

Every LLM provider uses a different message format. Before implementing message extraction, you **must** read the
provider's actual source code and existing plugin implementation to understand its specific format.

`llm` operations pass message objects to `tagLLMIO`. The tagger defaults a missing role to `''` and supports
content, tool-call, tool-result and audio fields; a tool-only message need not carry content.
Embedding, retrieval, workflow, agent, task, step, and tool operations use documents or text values instead.

Common roles: `'user'`, `'assistant'`, `'system'`, `'tool'`

## What Varies Per Provider

**Input formats differ in:**
- Field name for the messages array (`messages`, `contents`, `prompt`, etc.)
- Whether content is a plain string or an array of typed parts
- Role naming conventions (e.g., `'model'` vs `'assistant'`)

**Output formats differ in:**
- Response structure (`choices[0].message`, `content[0].text`, `candidates[0].content.parts`, etc.)
- Token usage field names (`prompt_tokens`/`completion_tokens` vs `input_tokens`/`output_tokens`)

Common variations include:
- **Simple array** — messages are already `[{role, content}]` (e.g. OpenAI)
- **Nested content blocks** — content is an array of typed objects (e.g. Anthropic `[{type: 'text', text: '...'}]`)
- **Parts format** — messages use a `parts` array inside a `contents` array (e.g. Google GenAI)
- **Role normalization** — provider uses different role names that must be mapped (e.g. Google's `'model'` →
  `'assistant'`)
- **Streaming** — content arrives as deltas that must be accumulated across chunks

## How to Research a New Provider

1. Read the package's tracing plugin (`packages/datadog-plugin-<name>/src/index.js`) for argument and result shapes
2. Look at the provider's SDK source or API docs to understand response shapes
3. Check an existing LLMObs plugin for a similar provider as a reference

## Reference Implementations

The best examples of message extraction for the providers we support:
- Anthropic: `packages/dd-trace/src/llmobs/plugins/anthropic/util.js`
- Google GenAI: `packages/dd-trace/src/llmobs/plugins/genai/util.js`

## Key Implementation Notes

- Preserve valid falsy values. Use nullish defaults such as `?? ''` or `?? []` when only `null` / `undefined` mean
  absent, and follow the provider's semantics when an empty value also means absent
- Normalize `'model'` role to `'assistant'` for consistency (preserve `'system'`, `'tool'`, `'function'`)
- For array content parts, the separator is the provider's, not a default: `genai/util.js` joins text parts with
  `'\n'`, `anthropic/util.js` with `','`
- For streaming, accumulate delta content across chunks before tagging
- Error output follows the integration contract: OpenAI and GenAI emit an empty message, while Anthropic omits
  output when there is no result
