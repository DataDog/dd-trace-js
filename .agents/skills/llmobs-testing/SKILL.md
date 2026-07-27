---
name: llmobs-testing
description: |
  Use when writing, modifying, or debugging tests for an LLMObs plugin in
  dd-trace-js. Triggers: "write LLMObs tests", "test an LLMObs plugin",
  "assertLlmObsSpanEvent", "useLlmObs", "getEvents", any MOCK_* matcher
  ("MOCK_STRING" / "MOCK_NOT_NULLISH" / "MOCK_NUMBER" / "MOCK_OBJECT"),
  "VCR cassette", "vcr proxy", "127.0.0.1:9126", "record a cassette",
  "test:llmobs:plugins".
---

# LLM Observability Testing Skill

## Decide how the package gets its responses first

**That choice picks the test strategy, the span kind, and the test structure, and the wrong one tests the wrong
contract** — cassettes for a workflow library record nothing, while pure-function tests for an HTTP wrapper miss the
network surface entirely. These are working categories for reasoning about a package; none of them exists as a
constant in the codebase.

- **LLM client / multi-provider** — talks provider HTTP itself (openai, anthropic, genai, ai, langchain): VCR
  cassettes.
- **Orchestration** — carries workflow or graph state and makes no provider calls of its own (langgraph): no VCR;
  drive nodes with plain return values.
- **Infrastructure** — implements a protocol or server (modelcontextprotocol-sdk): run the SDK's own server
  and client over its in-memory transport.
- **Canned `fetch` instead of a cassette** — where the spec supplies the responses itself: google-cloud-vertexai
  swaps `global.fetch` per test and stubs Google auth, openai-agents and some `ai` providers pass a `fetch` option
  to the client they construct.

See [references/category-strategies.md](references/category-strategies.md) for the forbidden-vs-required matrix per
strategy.

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

Provider traffic is recorded once and replayed afterwards. Clients reach the proxy at
`http://127.0.0.1:9126/vcr/{provider}`; the category block above decides which categories use it at all.

Two facts block every first run:

- **The proxy is the test-agent container**, not a script in this repo — `docker compose up -d testagent`.
  Without it every call fails with `ECONNREFUSED 127.0.0.1:9126`, which reads like a provider outage.
- **Cassettes live in one shared tree** under `packages/dd-trace/test/llmobs/cassettes/{provider}/`, with
  generated names, rather than beside the spec.

See [references/vcr-cassettes.md](references/vcr-cassettes.md) for recording, provider mapping, body
normalizers, and the commands to run a single integration.

### 3. Strategy Per Package Shape

The block at the top maps shape to strategy. The non-obvious bits:

- **LLM client / multi-provider**: proxy baseURL `http://127.0.0.1:9126/vcr/{provider}`, span kind `'llm'`. Cassettes
  are recorded once with real keys and replayed everywhere after.
- **Orchestration**: span kind `'workflow'` or `'agent'`, never `'llm'` — the orchestrator coordinates libraries that
  call providers rather than calling them itself. Nodes return plain values, so the test exercises graph execution
  instead of a provider API.
- **Infrastructure**: the SDK's own server and client over its in-memory transport, protocol-specific
  validation, no VCR.

See [references/category-strategies.md](references/category-strategies.md) for the patterns per shape.

### 4. Assertion Patterns

**assertLlmObsSpanEvent(actual, expected)**

Validates span structure with flexible matchers for non-deterministic values.

**Available matchers:** each one is a `typeof` or nullish check, not a value check.
- `MOCK_STRING` - any string, `''` included (use for output text)
- `MOCK_NOT_NULLISH` - anything but `null` / `undefined`, so `0` and `''` pass (use for token counts)
- `MOCK_NUMBER` - any number
- `MOCK_OBJECT` - anything with `typeof 'object'`, `null` included (opaque `schema` / `metadata` payloads, or
  a whole output message whose shape varies, as the `ai` specs do)

**Assertable fields:**
- `spanKind` (required) - one of `SPAN_KINDS` in `packages/dd-trace/src/llmobs/constants/tags.js`
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

**Location:** `packages/dd-trace/test/llmobs/plugins/{integration}/index.spec.js`. One file per
major-version surface when the SDK's shape changed across majors, named after it rather than kept in
one file — `openaiv3.spec.js` / `openaiv4.spec.js`, `index.spec.js` / `index.v7.spec.js`.

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

### What Every Span Assertion Pins

Beyond covering each instrumented method, once with a single message and once with a multi-turn
conversation where the surface takes one: `spanKind`, `name`, `modelName` and `modelProvider` on every
span; messages as `{ content, role }`; token counts truthy in `metrics`; and the parameters the caller
passed reflected in `metadata`.

### Span Kind Validation

Span kinds come from `SPAN_KINDS` in `packages/dd-trace/src/llmobs/constants/tags.js`:
- Chat/completions → `'llm'`
- Workflow execution → `'workflow'`
- Agent runs → `'agent'`
- Discrete unit of work inside a workflow → `'task'`
- Tool calls → `'tool'`
- Embeddings → `'embedding'`
- Retrieval → `'retrieval'`

### Error Handling

On errors the span is still submitted, with `outputMessages: [{ content: '', role: '' }]`. The specs that assert
an error pass all three fields, reaching for a matcher where the value varies (`type: MOCK_STRING` in the MCP
spec, `message: MOCK_STRING` in langchain):

```javascript
error: { type: 'Error', message: error.message, stack: error.stack },
```

The option decides only whether the expected event carries `status: 'error'` — `assertLlmObsSpanEvent`
copies the three error fields out of the span it is checking, so the values written here document the
throw without asserting it. Pin the identity of the error on the APM span the LLMObs span was built from:

```javascript
assert.strictEqual(apmSpans[0].meta['error.message'], error.message)
```

## References

For detailed information, see:

- [references/test-structure.md](references/test-structure.md) - Complete test file templates and organization
- [references/vcr-cassettes.md](references/vcr-cassettes.md) - VCR recording process, cassette management,
  troubleshooting
- [references/assertion-helpers.md](references/assertion-helpers.md) - Complete assertLlmObsSpanEvent API, matchers,
  patterns
- [references/category-strategies.md](references/category-strategies.md) - Detailed test strategy per package shape
