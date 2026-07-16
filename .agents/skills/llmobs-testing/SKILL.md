---
name: llmobs-testing
description: |
  Use when writing, modifying, or debugging tests for an LLMObs plugin in
  dd-trace-js. Triggers: "write LLMObs tests", "test an LLMObs plugin",
  "assertLlmObsSpanEvent", "useLlmObs", "getEvents", any MOCK_* matcher
  ("MOCK_STRING" / "MOCK_NOT_NULLISH" / "MOCK_NUMBER" / "MOCK_OBJECT"),
  "VCR cassette", "vcr proxy", "127.0.0.1:9126", any LlmObsCategory test
  ("LLM_CLIENT" / "MULTI_PROVIDER" / "ORCHESTRATION" / "INFRASTRUCTURE").
---

# LLM Observability Testing Skill

## Determine the package category first

**Before writing any test, determine the package's `LlmObsCategory`.** Category picks the test strategy (VCR or not), the span kind, and the test structure. The wrong category produces tests that pass against the wrong contract — VCR cassettes for a workflow library produce empty recordings; pure-function tests for an HTTP-call wrapper miss the network surface entirely.

Quick check:

- Direct HTTP calls to an LLM provider? → `LLM_CLIENT` or `MULTI_PROVIDER` — VCR.
- Workflow / graph orchestration with state? → `ORCHESTRATION` — no VCR, pure functions, real LLM as the orchestration node.
- Protocol / server implementation? → `INFRASTRUCTURE` — mock server.

See [references/category-strategies.md](references/category-strategies.md) for the FORBIDDEN-vs-REQUIRED matrix per category.

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

The category-determination block at the top maps category to strategy. Non-obvious bits per category:

- **LLM_CLIENT / MULTI_PROVIDER**: VCR proxy baseURL is `http://127.0.0.1:9126/vcr/{provider}`. Span kind: `'llm'`. Cassettes record once with real API keys; CI replays them.
- **ORCHESTRATION**: Span kind: `'workflow'` or `'agent'`, never `'llm'`. No VCR, no real API calls — the orchestrator itself doesn't make HTTP calls, it coordinates libraries that do. Mock LLM responses as plain return values from the node so the test exercises the workflow execution, not the provider API.
- **INFRASTRUCTURE**: Mock server, protocol-specific validation, no VCR.

See [references/category-strategies.md](references/category-strategies.md) for per-category patterns.

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

## References

For detailed information, see:

- [references/test-structure.md](references/test-structure.md) - Complete test file templates and organization
- [references/vcr-cassettes.md](references/vcr-cassettes.md) - VCR recording process, cassette management, troubleshooting
- [references/assertion-helpers.md](references/assertion-helpers.md) - Complete assertLlmObsSpanEvent API, matchers, patterns
- [references/category-strategies.md](references/category-strategies.md) - Detailed test strategies for each LlmObsCategory
