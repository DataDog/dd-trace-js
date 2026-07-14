# Stage 20: Genkit LLMObs test strategy

Date: 2026-07-14 UTC

## Category and strategy declaration

- Package category: `LlmObsCategory.ORCHESTRATION` (high confidence).
- Test strategy: pure, in-process tests using exact `genkit@1.21.0` local model, flow, flow-step, tool, retriever,
  and embedder actions. The tests exercise Genkit's real action lifecycle without provider clients or transports.
- Forbidden patterns: VCR cassettes, VCR/proxy URLs, HTTP configuration, provider API calls, credentials, and client
  classes.
- Required patterns: `useLlmObs`, `assertLlmObsSpanEvent`, exact local action results, success and runner-error
  coverage, streaming completion/error, native parent relationships, ignored-label context preservation, overload
  selection, and privacy assertions.

Genkit is a reviewed hybrid within the orchestration category. Unlike a generic graph-only orchestrator, its one
native action lifecycle also represents provider-neutral model, tool, retrieval, and embedding work. The Stage 12
and Stage 19 contract therefore overrides the generic orchestration template's “never llm” rule for model actions:
model actions must emit `llm`, while flows/steps emit `workflow`, tools emit `tool`, retrievers emit `retrieval`, and
embedders emit `embedding`. No `agent` span is expected.

## Planned coverage

1. Model normalization: text roles, tool calls/results, excluded unsafe parts, numeric token metrics, and scalar
   metadata allowlisting.
2. Model runner errors and streaming success/error, proving event emission waits for final provider completion.
3. Flow and named flow-step I/O plus parent-child relationships.
4. Tool success/error and exact `ToolInterruptError` behavior.
5. Retrieval query/document normalization and metadata allowlisting.
6. Embedding input normalization, count/dimension summary, and numeric-vector omission.
7. Ignored native labels, malformed/valid serialized-output fallback, and selected-parent context preservation.
8. Source-supported three-argument `runInNewSpan` overload where the exact public tracing API permits it.

The only category-appropriate reference studied was the repository's LangGraph orchestration suite. Provider/VCR
test implementations were not used.
