# Stage 15: tracing test fixer

Date: 2026-07-14 UTC

## Fix

Applied the single production correction diagnosed in Stage 14:

```diff
- static prefix = 'orchestrion:@genkit-ai/core:runInNewSpan'
+ static prefix = 'tracing:orchestrion:@genkit-ai/core:runInNewSpan'
```

No instrumentation target, package range, timeout, test, or assertion was changed. No test was deleted, skipped, or
weakened.

## Focused exact-version test

Command from `/workspace/repo`:

```sh
env -u OTEL_TRACES_EXPORTER \
  -u OTEL_LOGS_EXPORTER \
  -u OTEL_METRICS_EXPORTER \
  -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha packages/datadog-plugin-genkit/test/index.spec.js
```

Result:

```text
with @genkit-ai/core 1.21.0 (1.21.0)
  passed: instruments model actions
  passed: instruments flows and named flow steps
  passed: instruments tool actions
  passed: instruments retriever actions
  passed: instruments embedder actions

5 passing (1s)
DATADOG TRACER INTEGRATIONS LOADED - ["fs","net","dns","child_process","genkit","http","express"]
```

The environment removals are required for an authoritative run: inherited OTEL exporters bypass the mock trace
agent, and this sandbox's inherited empty `DD_AGENT_HOST` produces an invalid `http:` URL before plugin-manager
configuration.

## Static validation

Commands:

```sh
node --check packages/datadog-plugin-genkit/src/index.js
npm exec -- eslint \
  packages/datadog-plugin-genkit/src/index.js \
  packages/datadog-plugin-genkit/test/index.spec.js
git diff --check
```

All exited 0 with no output. A direct static assertion printed the configured prefix:

```text
tracing:orchestrion:@genkit-ai/core:runInNewSpan
```

Pipeline progress was not edited and no commit was created by this stage worker.
