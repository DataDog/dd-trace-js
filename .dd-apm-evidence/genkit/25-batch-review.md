# Stage 25: batch review of the Genkit integration

Date: 2026-07-14 UTC

## Decision

**Changes required.** The review found three PR-blocking issues. They are recorded as machine-readable todos in
`25-batch-review.json`.

The review covered the complete implementation relative to original base
`372e5eb61c4c6a13662ad2f8780a87275b50314d`, excluding pipeline/evidence artifacts, and included the currently
untracked LLMObs spec. It read the exact installed `@genkit-ai/core@1.21.0` and `@genkit-ai/ai@1.21.0` source.

## Blocking findings

### GENKIT-BATCH-001 — model and provider metadata are not populated

`GenkitLLMObsPlugin.getLLMObsSpanRegisterOptions()` returns only `kind` and `name`. It never returns `modelName` or
`modelProvider` for model or embedder actions. The LLMObs processor therefore reports both fields as `custom`, and
the tests explicitly accept that generic fallback even for named actions such as `local/normalization-model` and
`localEmbedder`.

This misses the required model/provider metadata. The hook exposes the registered action name at
`options.metadata.name`; exact core source also proves that object action names are normalized to
`pluginId/actionId` in `src/action.ts:287-290`. The fix should always retain a proven model/embedder identity and
derive a provider only from an explicitly supported, proven prefix. Unknown providers should remain undefined,
not guessed.

### GENKIT-BATCH-002 — provider integration ownership/demotion is absent

Every model action is registered as kind `llm`, and its Genkit usage is always tagged as LLM token metrics. There is
no provider mapping, plugin-manager check, or demotion path. When a supported underlying provider LLMObs integration
is enabled, this creates two authoritative `llm` spans and double-counts token/cost metrics.

This was already a mandatory Stage 06/12 implementation constraint. The existing LangChain implementation at
`packages/dd-trace/src/llmobs/plugins/langchain/index.js:12-16,122-155` provides the repository precedent: only
recognized supported providers are checked, the framework span becomes `workflow` when the provider integration is
enabled, and custom/uninstrumented models remain framework-owned LLM spans.

### GENKIT-BATCH-003 — OTel-enabled execution duplicates spans and leaks raw payload/vector metadata

The issue is runtime-proven. With `DD_TRACE_OTEL_ENABLED=true`, Genkit's native `runInNewSpan` span is exported in
addition to the new Datadog Genkit span. A focused flow test receives three spans instead of its two selected spans.
The native span serializes Genkit metadata directly into ordinary APM tags. The focused embedder reproduction
contains:

```text
'genkit:input': '{"input":[{"content":[{"text":"hello"}]}]}'
'genkit:output': '{"embeddings":[{"embedding":[1,2,3]}]}'
```

This violates both the no-duplicate requirement and the reviewed safe-APM-tag/vector-omission contract. Stage 26
must establish one authoritative topology for OTel-enabled users and add an exact-version regression test. Merely
loosening the current span-count assertion would preserve the correctness and privacy defect.

Evidence:

- `25-attempts/otel-duplicate-flow.log` — `0 passing, 1 failing`, with `3 !== 2`.
- `25-attempts/otel-embedding-payload.log` — native span includes raw input and numeric embedding output.

## Checks that passed

- Orchestrion targets the named async `runInNewSpan` in exact `@genkit-ai/core@1.21.0` CJS and MJS artifacts.
- The `tracing:orchestrion:@genkit-ai/core:runInNewSpan` prefix matches emitted lifecycle channels.
- Composite ordering is correct: tracing `bindStart` creates the APM span before the LLMObs `start` subscriber;
  LLMObs `asyncEnd` tags before tracing finishes the span.
- Ignored native labels retain the ambient Datadog and LLMObs parent context without creating selected spans.
- Promise completion covers final provider output for streaming; success and error lifecycles finish.
- `llm`, `workflow`, `tool`, `retrieval`, and `embedding` kinds use the matching tagger APIs.
- Messages, roles, tool calls/results, and documents are normalized to tagger-valid shapes.
- Genkit LLMObs embedding output is summarized and its numeric vectors/arbitrary embedding metadata are omitted in
  the default configuration.
- The hook remains exactly version-scoped; no unsupported wider compatibility claim is made.
- Plugin aliases, instrumentation loader/rewriter registry, config types, v6/v5 public types, docs, fixture
  versions, exercised-test coverage, and CI job are present.
- Production hot-path work is constant-time when LLMObs is disabled; LLMObs extraction occurs only when enabled.

## Commands and results

Default exact-version focused suites:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
```

Result: `18 passing (1s)`.

OTel duplicate reproduction:

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  DD_TRACE_OTEL_ENABLED=true ./node_modules/.bin/mocha \
  packages/datadog-plugin-genkit/test/index.spec.js \
  --grep 'instruments flows and named flow steps'
```

Result: exit 1, `0 passing, 1 failing`; the trace contains three spans rather than two.

The corresponding embedder command exits 0 only because `assertFirstTraceSpan` continues past the mismatching
native span to the later matching Datadog span; its captured mismatch still proves the duplicate native span and raw
vector tag.

Additional read-only check:

```text
node scripts/verify-exercised-tests.js
All test files are covered by at least one package.json script glob.
All CI workflows reference valid scripts, and plugin setup looks consistent.
```

No production code, tests, or pipeline progress was modified by this reviewer.
