---
name: llmobs-testing
description: |
  This skill should be used when the user asks to "write LLMObs tests", "add tests for LLM Observability",
  "test an LLMObs plugin", "llmobs test", "llmobs spec", "test llm observability",
  "assertLlmObsSpanEvent", "useLlmObs", "getEvents",
  "MOCK_STRING", "MOCK_NOT_NULLISH", "MOCK_NUMBER", "MOCK_OBJECT",
  "VCR cassette", "record cassette", "replay cassette", "vcr proxy", "llmobs cassette",
  "test chat completions", "test streaming", "test embeddings", "test agent runs",
  "test orchestration", "test workflow", "llmobs span event",
  "LLMObs test strategy", "LlmObsCategory test",
  "LLM_CLIENT test", "MULTI_PROVIDER test", "ORCHESTRATION test", "INFRASTRUCTURE test",
  "span kind llm test", "span kind workflow test",
  "inputMessages", "outputMessages", "token metrics", "llmobs span validation",
  "cassette not generated", "re-record cassette", "127.0.0.1:9126",
  or needs to write, modify, or debug tests for any LLMObs plugin in dd-trace-js.
---

# LLM Observability Testing Skill

## ⚠️ CRITICAL: Read This First ⚠️

**BEFORE writing any test, you MUST determine the package category.**

**The category determines EVERYTHING:**
- Whether to use VCR or not
- What spanKind to use
- What test structure to follow
- What examples to study

**IF YOU USE THE WRONG CATEGORY STRATEGY, THE TEST WILL FAIL.**

**Categories are defined in the `LlmObsCategory` enum.**

**Quick check:**
- Does package make HTTP calls to LLM APIs? → `LLM_CLIENT` or `MULTI_PROVIDER` (use VCR)
- Does package orchestrate workflows/graphs? → `ORCHESTRATION` (NO VCR, pure functions)
- Does package implement protocols/servers? → `INFRASTRUCTURE` (mock servers)

**See [references/category-strategies.md](references/category-strategies.md) for FORBIDDEN vs REQUIRED patterns per category.**

---

## Purpose

This skill helps you write comprehensive LLMObs tests that validate span events, messages, tokens, and metadata using category-appropriate strategies.

## When to Use

- Writing tests for a new LLMObs plugin (ALWAYS check category first)
- Understanding category-specific test strategies
- Learning VCR cassettes (for LLM_CLIENT/MULTI_PROVIDER only)
- Learning assertion patterns for LLMObs spans

## Core Testing Concepts

### 1. Test Structure

LLMObs tests use special helpers to validate span events.

**Key components:**
- `useLlmObs()` - Initializes LLMObs test environment
- `getEvents()` - Retrieves captured span events
- `assertLlmObsSpanEvent()` - Validates span structure with flexible matchers

**Basic test flow:**
1. Initialize test environment with `useLlmObs({ plugin: 'name' })`
2. Call instrumented method (chat completion, workflow execution, etc.)
3. Get captured span events with `getEvents()`
4. Validate span structure with `assertLlmObsSpanEvent()`

See [references/test-structure.md](references/test-structure.md) for complete test file templates.

### 2. VCR Cassettes

VCR records real API calls and replays them in tests for deterministic testing without external dependencies.

**Purpose:**
- Record real LLM API responses once
- Replay deterministically in CI without API keys
- No external dependencies after recording

**How it works:**
1. Configure proxy baseURL: `http://127.0.0.1:9126/vcr/{provider}`
2. Run tests with real API keys (first time only)
3. VCR proxy records requests/responses to cassette files
4. Subsequent test runs replay from cassettes (no API keys needed)

**Cassette location:** `test/llmobs/plugins/{integration}/cassettes/`

**When to use VCR:**
- ✅ `LlmObsCategory.LLM_CLIENT` (Direct API wrappers)
- ✅ `LlmObsCategory.MULTI_PROVIDER` (Multi-provider frameworks)
- ❌ `LlmObsCategory.ORCHESTRATION` (Pure functions, no API calls)
- ❌ `LlmObsCategory.INFRASTRUCTURE` (Mock servers instead)

See [references/vcr-cassettes.md](references/vcr-cassettes.md) for recording process and troubleshooting.

### 3. Category-Specific Test Strategies

Test strategy is determined by the `LlmObsCategory` enum.

#### LlmObsCategory.LLM_CLIENT & LlmObsCategory.MULTI_PROVIDER

**Strategy:** VCR with real API calls via proxy

**Characteristics:**
- Use VCR proxy baseURL
- Record cassettes with real API keys
- Tests make actual HTTP calls (recorded once)
- Validate LLM-specific data (messages, tokens, model info)

**Span kind:** Usually `'llm'` for chat completions

See [references/category-strategies.md](references/category-strategies.md) for detailed patterns.

#### LlmObsCategory.ORCHESTRATION

**Strategy:** Pure function tests, NO VCR, NO real API calls

**Characteristics:**
- NO VCR cassettes
- NO HTTP calls to LLM providers
- Use library's native APIs with mock/test LLM responses
- Focus on workflow lifecycle, not API calls
- **CRITICAL:** Still test with actual LLM as orchestration node (not mocked completely)

**Span kind:** Usually `'workflow'` or `'agent'`, NOT `'llm'`

**Example concept:**
- LangGraph invokes nodes that call LLMs
- LangGraph itself doesn't make HTTP calls
- Test LangGraph's workflow execution, not the underlying LLM API

See [references/category-strategies.md](references/category-strategies.md) for orchestration test patterns.

#### LlmObsCategory.INFRASTRUCTURE

**Strategy:** Mock server tests

**Characteristics:**
- Mock server implementation
- Protocol-specific validation
- NO VCR

See [references/category-strategies.md](references/category-strategies.md) for infrastructure test patterns.

### 4. Assertion Patterns

**assertLlmObsSpanEvent(actual, expected)**

Validates span structure with flexible matchers for non-deterministic values.

**Available matchers:**
- `MOCK_STRING` - Matches any non-empty string (use for output text)
- `MOCK_NOT_NULLISH` - Matches any truthy value (use for token counts)
- `MOCK_NUMBER` - Matches any number
- `MOCK_OBJECT` - Matches any object (use for errors)

**Assertable fields:**
- `spanKind` (required) - Span type from `LlmObsSpanKind` enum
- `name` - Operation name
- `modelName` - Model identifier (for LLM spans)
- `modelProvider` - Provider name (for LLM spans)
- `inputMessages` - Input messages in `[{content, role}]` format
- `outputMessages` - Output messages in `[{content, role}]` format
- `metrics` - Token usage (`input_tokens`, `output_tokens`, `total_tokens`)
- `metadata` - Model parameters (`temperature`, `max_tokens`, etc.)
- `error` - Error object (if operation failed)

**Partial validation:** Only specified fields are checked, others ignored.

See [references/assertion-helpers.md](references/assertion-helpers.md) for complete API and patterns.

## Test File Organization

**Location:** `test/llmobs/plugins/{integration}/index.spec.js`

**Structure:**
1. Import helpers from `'../../util'`
2. Initialize LLMObs test environment
3. Load modules in `beforeEach()` for fresh state
4. Group tests by method (`describe('chat completions', ...)`)
5. Cover all instrumented methods
6. Test error cases

**Standard imports:**
```
useLlmObs, assertLlmObsSpanEvent, MOCK_STRING, MOCK_NOT_NULLISH, MOCK_NUMBER, MOCK_OBJECT
```

See [references/test-structure.md](references/test-structure.md) for complete template.

## Key Testing Points

### Coverage Requirements

Test all instrumented methods with:
- ✅ Basic operation (single message/call)
- ✅ Multi-turn conversations (if applicable)
- ✅ Error cases
- ✅ All required span fields (spanKind, name, modelName, modelProvider)
- ✅ Message format validation (`{content, role}` structure)
- ✅ Metrics validation (token counts exist and are truthy)
- ✅ Metadata validation (parameters passed through)

### Span Kind Validation

Match span kind to operation type using `LlmObsSpanKind` enum:
- Chat/completions → `'llm'`
- Workflow execution → `'workflow'`
- Agent runs → `'agent'`
- Tool calls → `'tool'`
- Embeddings → `'embedding'`
- Retrieval → `'retrieval'`

### Error Handling

On errors, validate:
- Empty output messages: `[{content: '', role: ''}]`
- Error object exists: `error: MOCK_OBJECT`
- Span still created (not dropped)

## Common Patterns by Category

### LLM_CLIENT / MULTI_PROVIDER Pattern
- Use VCR proxy baseURL
- Test chat completions with various parameters
- Validate real API response structure
- Test streaming (if supported)
- Test error responses

### ORCHESTRATION Pattern
- NO VCR
- Test workflow lifecycle methods (invoke, stream, run)
- Use mock LLM responses within workflow
- Focus on workflow span, not LLM spans
- Validate workflow-specific metadata (state, nodes, edges)

### INFRASTRUCTURE Pattern
- Mock server setup
- Protocol-specific validation
- Connection/transport testing

## Best Practices

1. **Use MOCK_* for non-deterministic values** - Output text, token counts, error objects
2. **Use exact values for inputs** - You control input messages and parameters
3. **Always validate spanKind** - Required for every span
4. **Match category to test strategy** - VCR for clients, pure functions for orchestration
5. **Test error paths** - Verify empty outputs and error objects on failures
6. **Group by method** - Organize tests by instrumented method
7. **Load modules fresh** - Use beforeEach() to avoid state leakage
8. **Cover edge cases** - Empty messages, missing metadata, streaming

## References

For detailed information, see:

- [references/test-structure.md](references/test-structure.md) - Complete test file templates and organization
- [references/vcr-cassettes.md](references/vcr-cassettes.md) - VCR recording process, cassette management, troubleshooting
- [references/assertion-helpers.md](references/assertion-helpers.md) - Complete assertLlmObsSpanEvent API, matchers, patterns
- [references/category-strategies.md](references/category-strategies.md) - Detailed test strategies for each LlmObsCategory

## Key Principles

1. **Category determines strategy** - Always check `LlmObsCategory` to pick test approach
2. **Orchestrators don't use VCR** - They don't make direct API calls
3. **Use matchers for variance** - Real API responses vary, use MOCK_* matchers
4. **Validate message format** - Always check `{content, role}` structure
5. **Test with real behavior** - For orchestrators, use actual LLM as node (not fully mocked)
