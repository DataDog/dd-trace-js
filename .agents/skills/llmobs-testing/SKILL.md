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

## Decide how each instrumented surface gets its responses first

**That choice picks the response source and test setup** — cassettes for a workflow record nothing, while
pure-function tests for a provider-backed call miss the network surface entirely. The operation independently
determines its span kind and fields. These are working categories for reasoning; none exists as a code constant.

- **LLM client / multi-provider** — reaches provider HTTP directly or through a supplied provider package (openai,
  anthropic, genai, ai, langchain): VCR cassettes or a canned `fetch`.
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

### 3. Response Strategy And Operation Kind

The block at the top maps response source to test strategy. The operation maps independently to a span kind:

- **Provider-backed LLM client / multi-provider operations**: use the proxy baseURL
  `http://127.0.0.1:9126/vcr/{provider}` or a canned `fetch`. Chat and generation emit `llm`; LangChain and `ai`
  also expose operations with other kinds.
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

**Required fields:** `span`, `spanKind`, `name`, `tags`. A missing `tags` throws
`TypeError: Cannot read properties of undefined (reading 'ml_app')` instead of failing an assertion, and every
plugin span carries at least `{ ml_app: 'test', integration: '<integration>' }`.

**Optional fields:** `modelName`, `modelProvider`, `inputMessages`, `outputMessages`, `inputDocuments`,
`outputDocuments`, `inputValue`, `outputValue`, `metrics`, `metadata`, `toolDefinitions`, `error`, `parentId`,
`sessionId`, `traceId`. Omitting a field asserts its absence rather than ignoring it: no model fields, no input, no
output, no metadata, no tool definitions, `metrics` of `{}`, `status: 'ok'`, and the root parent id. `traceId` is
the exception: omission defaults to `MOCK_STRING` because every event has one. See
[references/assertion-helpers.md](references/assertion-helpers.md) for the patterns.

## Test File Organization

**Location:** `packages/dd-trace/test/llmobs/plugins/{integration}/index.spec.js`. One file per
major-version surface when the SDK's shape changed across majors, named after it rather than kept in
one file — `openaiv3.spec.js` / `openaiv4.spec.js`, `index.spec.js` / `index.v7.spec.js`.

**Structure:**
1. Import helpers from `'../../util'`
2. Initialize LLMObs test environment
3. Load modules after `useLlmObs()` installs the tracer, then recreate mutable clients per test
4. Group tests by method (`describe('chat completions', ...)`)
5. Cover all instrumented methods
6. Test error cases

**Standard imports:**
```
useLlmObs, assertLlmObsSpanEvent, MOCK_STRING, MOCK_NOT_NULLISH, MOCK_NUMBER, MOCK_OBJECT
```

See [references/test-structure.md](references/test-structure.md) for complete template.

## Span Kinds And The Fields They Carry

`SPAN_KINDS` in `packages/dd-trace/src/llmobs/constants/tags.js` is the list the public SDK validates against:
`llm` (chat / completions), `workflow`, `agent`, `task` (a unit of work inside a workflow), `tool`, `embedding`,
`retrieval`. Plugins set the kind directly and skip that validation, so kinds outside the list exist — `ai` v7
and claude-agent-sdk both emit `step`.

Pinning a field the kind never emits asserts metadata production does not produce:

- `llm` — `modelName`, `modelProvider`, `inputMessages` / `outputMessages`, and any emitted token `metrics` /
  `metadata`
- `embedding` — `modelName`, `modelProvider`, `inputDocuments`, `outputValue`, sometimes `metrics`
- `retrieval` — `inputValue`, `outputDocuments`
- `workflow` / `agent` / `task` / `step` / `tool` — kind-specific `inputValue` / `outputValue`, sometimes
  `metadata`, never
  model fields or token metrics

Cover every instrumented method, and a multi-turn conversation where the surface takes one.

## Error Handling

On errors the span is still submitted. Match the plugin's output contract: OpenAI and GenAI carry
`outputMessages: [{ content: '', role: '' }]`, while Anthropic and non-`llm` integrations may omit output.
Pass a truthy marker to expect an error:

```javascript
error: {},
```

The option decides only whether the expected event carries `status: 'error'` — `assertLlmObsSpanEvent`
copies the three error fields out of the span it is checking, so the marker does not pin the throw.
A call that resolves still fails on that status. Pin which error was thrown on the APM span the LLMObs
span was built from:

```javascript
assert.strictEqual(apmSpans[0].meta['error.message'], error.message)
```
