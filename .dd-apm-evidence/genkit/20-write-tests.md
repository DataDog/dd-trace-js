# Stage 20: Genkit LLMObs tests

Date: 2026-07-14 UTC

## Result

Stage 20 passes. `packages/datadog-plugin-genkit/test/llmobs.spec.js` adds 13 exact-version, in-process LLMObs tests
for `genkit@1.21.0` and `@genkit-ai/core@1.21.0`. The suite uses the `ORCHESTRATION` strategy: real local Genkit
actions with deterministic function results, no VCR, network, provider API, client class, credentials, or service.

The reviewed Genkit hybrid contract is pinned rather than the generic graph-only template: model actions emit
`llm`; flows and named steps emit `workflow`; tools emit `tool`; retrievers emit `retrieval`; embedders emit
`embedding`. No `agent` span is expected.

## Coverage

The tests cover:

- model text/role normalization, tool calls/results, unsafe-part exclusion, token metrics, scalar metadata, and
  default custom model/provider event fields;
- model runner errors with retained input and empty message output;
- fully consumed two-chunk streaming through final response, plus streaming runner rejection;
- flow and named flow-step I/O and direct LLMObs/APM parent relationships;
- runner errors for flow, flow-step, tool, retrieval, and embedding;
- direct tool success and `ToolInterruptError`, including successful interrupted outer generation;
- retrieval query/document conversion and the `name`/`id`/`score` metadata allowlist;
- embedding document conversion, count/dimension summary, and absence of numeric vectors/arbitrary metadata;
- selected parent context through an ignored native `util` span;
- valid serialized-output fallback and malformed fallback JSON;
- the source-supported three-argument `runInNewSpan` overload.

Privacy assertions prove the configured sentinel secrets, media/data URLs, unsupported usage, and vector values are
absent from emitted event JSON.

## Validation

Run from `/workspace/repo`:

```sh
node --check packages/datadog-plugin-genkit/test/llmobs.spec.js
npm exec -- eslint packages/datadog-plugin-genkit/test/llmobs.spec.js
env -u OTEL_TRACES_EXPORTER \
  -u OTEL_LOGS_EXPORTER \
  -u OTEL_METRICS_EXPORTER \
  -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha --timeout 20000 packages/datadog-plugin-genkit/test/llmobs.spec.js
git diff --check
```

Results:

```text
node --check: exit 0, no output
targeted ESLint: exit 0, no output
LLMObs suite: 13 passing (1s), 0 failing, 0 pending
git diff --check: exit 0, no output
```

The Mocha output contains the repository's non-failing warnings about Mocha/test-server dependencies loading before
`dd-trace`; the Genkit integration loads and all assertions pass. The authoritative transcript is
`20-attempts/test-output-final.log`; syntax, lint, and diff-check transcripts are in the same directory.

## Provenance and scope

```text
59aa6c2d5a0b7e241d08c1711e81da2d6ce2782ecec5367fc7ffccd99207b6e4  test/llmobs.spec.js
df2ddd373a215859081287b3da6e39f8fb5c7f4460683dfa9935c6cfecc31d75  LLMObs plugin under test
6f35979f86e9977b1917cdfbd33dded908fd552822732b6f4c18032bc51a70ef  final test transcript
```

Stage 20 created only the LLMObs spec and evidence. It did not modify production code or `PROGRESS.md`. No cassette
was created.
