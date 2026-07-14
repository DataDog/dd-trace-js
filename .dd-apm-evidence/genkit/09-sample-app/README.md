# Genkit 1.21.0 offline sample

This Stage 09 fixture exercises public Genkit APIs against exact `genkit@1.21.0`, `@genkit-ai/core@1.21.0`, and
`@genkit-ai/ai@1.21.0`. The application does not import `dd-trace`, contact a model provider, require credentials,
or use an external service. It registers real local Genkit actions so every selected operation crosses Genkit's
actual `runInNewSpan` execution boundary.

## Reproduction

From this directory:

```sh
yarn install --frozen-lockfile
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
npm run sample
npm run esm-smoke
node --check sample-app.js
node --check esm-smoke.mjs
npm list genkit @genkit-ai/core @genkit-ai/ai --depth=1
```

Run the targeted lint check from `/workspace/repo`, whose development dependencies provide ESLint:

```sh
cd /workspace/repo
npm exec -- eslint --no-ignore --rule strict:off --report-unused-disable-directives-severity off \
  .dd-apm-evidence/genkit/09-sample-app/sample-app.js \
  .dd-apm-evidence/genkit/09-sample-app/esm-smoke.mjs
```

`sample-app.js` continues after every expected runner rejection and writes structured output to
`sample-results.json`. Set `RESULTS_PATH` to select another output location. The ESM smoke app proves the public ESM
entry can execute a model operation; the primary CommonJS app reaches the selected CommonJS instrumentation file.

## Exercised cases

- Non-streaming model success and rejection.
- Streaming success with both chunks consumed before separately awaiting the final response, plus stream rejection.
- Flow success with a named flow step, and separate flow and flow-step rejections.
- Automatic `model-turn-1 -> tool -> model-turn-2` execution and direct tool success/rejection.
- Genkit beta tool interrupt, observed as a successful response with `finishReason: interrupted`.
- Retriever success/rejection and two-document embedder success/rejection.

## Evidence and limitation

`sample-run-output.txt`, `sample-results.json`, and `esm-smoke-output.txt` are captured real executions.
`environment-output.txt` pins versions. Yarn, syntax-check, and ESLint transcripts are stored alongside them. The
ESLint command disables the ESM `strict` rule because Stage 09 explicitly requires every JavaScript source, including
the `.mjs` smoke file, to begin with `'use strict'`; it also suppresses unused-disable reporting for the other
mandatory header directive.

No context snapshot is present. Stage 08 supplied neither a context-capture tool nor a capture command, and this
workflow forbids invoking `dd-apm` or a nested runner. `context-capture-blocker.json` records the exact unavailable
capability. A later stage must run the sample with the repository instrumentation and preserve APM plus LLMObs
output; this Stage 09 result does not claim an observability-gate pass.
