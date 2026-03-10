# Message Extraction Patterns

## Overview

Every LLM provider uses a different message format. Before implementing `extractInputMessages` and `extractOutputMessages`, you **must** read the provider's actual source code and existing plugin implementation to understand its specific format.

All plugins must normalize messages to the standard LLMObs format: `[{ content: string, role: string }]`

Common roles: `'user'`, `'assistant'`, `'system'`, `'tool'`

## What Varies Per Provider

**Input formats differ in:**
- Field name for the messages array (`messages`, `contents`, `prompt`, etc.)
- Whether content is a plain string or an array of typed parts
- Role naming conventions (e.g., `'model'` vs `'assistant'`)

**Output formats differ in:**
- Response structure (`choices[0].message`, `content[0].text`, `candidates[0].content.parts`, etc.)
- Token usage field names (`prompt_tokens`/`completion_tokens` vs `input_tokens`/`output_tokens`)

## How to Research a New Provider

1. Read the existing tracing plugin for the package (`packages/datadog-plugin-<name>/src/index.js`) to understand what arguments and results look like
2. Look at the provider's SDK source or API docs to understand response shapes
3. Check an existing LLMObs plugin for a similar provider as a reference

## Reference Implementations

The best examples of message extraction for the providers we support:
- Anthropic: [`packages/datadog-plugin-anthropic/src/llmobs.js`](../../../../../packages/datadog-plugin-anthropic/src/llmobs.js)
- Google GenAI: [`packages/datadog-plugin-google-genai/src/llmobs.js`](../../../../../packages/datadog-plugin-google-genai/src/llmobs.js)

## Key Implementation Notes

- Always handle null/undefined with fallback defaults
- Normalize `'model'` role to `'assistant'` for consistency
- For array content parts (Anthropic, Google), join text parts with `''`
- For streaming, accumulate delta content across chunks before tagging
- Always return `[{ content: '', role: '' }]` on error (never omit output messages)
