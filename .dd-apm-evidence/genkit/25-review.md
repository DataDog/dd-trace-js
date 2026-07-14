# Stage 25 review

Decision: **changes required**.

The complete implementation relative to original base `372e5eb61c4c6a13662ad2f8780a87275b50314d` was reviewed
against exact `@genkit-ai/core@1.21.0` source and the repository APM/LLMObs contracts.

## PR-blocking todos

1. `GENKIT-BATCH-001`: model and embedder events do not register their actual identity. The plugin returns only
   `kind` and `name`, so tests accept `model_name=custom` and `model_provider=custom`. Preserve the registered action
   name as model identity and derive a provider only from a proven supported prefix.
2. `GENKIT-BATCH-002`: provider ownership is absent. Genkit always emits an authoritative `llm` span and token
   metrics even when a supported enabled provider plugin owns the request. Implement the existing LangChain-style
   provider check and workflow demotion to prevent double-counted LLM spans/tokens.
3. `GENKIT-BATCH-003`: `DD_TRACE_OTEL_ENABLED=true` runtime evidence produces duplicate native Genkit spans. Those
   spans carry raw `genkit:input` and `genkit:output`; the embedder reproduction includes `[1,2,3]` in ordinary APM
   metadata. Establish and test one authoritative OTel-enabled topology and prevent raw payload/vector leakage.

Machine-readable details are in `25-review.json`. Runtime evidence:

- `25-attempts/otel-duplicate-flow.log`: `0 passing, 1 failing`, with three spans instead of two.
- `25-attempts/otel-embedding-payload.log`: native tags contain raw input and the numeric embedding vector.

## Passed review areas

- Exact-version CJS/MJS Orchestrion hook and emitted channel prefix.
- Composite order, ignored-span context preservation, async finish/error/stream completion.
- Five LLMObs kinds and tagger-valid message/tool/document conversions.
- Vector omission in the Genkit-authored LLMObs embedding event under default OTel-disabled operation.
- Plugin/config/type/docs/fixture/CI registrations and exact compatibility scope.
- Default focused suites: `18 passing (1s)` with telemetry exporters and empty `DD_AGENT_HOST` removed.
- `node scripts/verify-exercised-tests.js`: all test files and workflow scripts are covered/valid.

No production code, tests, or pipeline progress was modified by this reviewer.
