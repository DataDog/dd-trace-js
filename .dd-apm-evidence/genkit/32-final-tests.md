# Stage 32: final tests gate

Date: 2026-07-14 UTC

## Result

**Passed.** Every required test exits zero on the frozen Stage 31 source diff
`2f18329cc57421c538109e8fab5a216cd52a6f36a1ba2d1d3d547a3948bf1422`.
No production source, test, or pipeline progress file was modified by this stage.

The required CI-equivalent command was run first exactly as specified, with only
the three OTel exporter variables removed. The sandbox exports `DD_AGENT_HOST=`.
That inherited empty value produced the previously diagnosed environment-only
failure: 2 passing and 21 span-wait timeouts, exit 21. Running the identical
command with the empty `DD_AGENT_HOST` additionally removed passed all 23 Genkit
APM and LLMObs tests, exit 0. The source diff hash was unchanged.

## Commands and counts

### Required targeted CI command, inherited empty agent host

```sh
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
PLUGINS=genkit npm run test:plugins:ci
```

Result: exit `21`; `2 passing`, `21 failing` by timeout. This is retained as
environment diagnosis evidence, not treated as a product-test pass.

Log: `32-attempts/test-plugins-ci-inherited-agent-host.log`.

### Authoritative targeted CI command

```sh
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER DD_AGENT_HOST
PLUGINS=genkit npm run test:plugins:ci
```

Result: exit `0`; `23 passing`, `0 failing`, `0 pending` against exact
`@genkit-ai/core@1.21.0`. This command also ran the repository plugin service
installer and c8 CI wrapper.

Log: `32-attempts/test-plugins-ci-authoritative.log`.

### Direct default Genkit suites

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha --timeout 20000 \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
```

Result: exit `0`; `23 passing`, `0 failing`, `0 pending`.

Log: `32-attempts/direct-default.log`.

### Direct OTel-enabled Genkit suites

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  DD_TRACE_OTEL_ENABLED=true ./node_modules/.bin/mocha --timeout 20000 \
  packages/datadog-plugin-genkit/test/index.spec.js \
  packages/datadog-plugin-genkit/test/llmobs.spec.js
```

Result: exit `0`; `23 passing`, `0 failing`, `0 pending`. This pins native
Genkit scope suppression, payload/vector privacy, unrelated user OTel children,
and operation-scoped context cleanup.

Log: `32-attempts/direct-otel-enabled.log`.

### Shared OTel bridge suites

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha \
  packages/dd-trace/test/opentelemetry/context_manager.spec.js \
  packages/dd-trace/test/opentelemetry/tracer.spec.js
```

Result: exit `0`; `49 passing`, `0 failing`, `0 pending`.

Log: `32-attempts/shared-otel.log`.

### Plugin structure

```sh
env -u OTEL_TRACES_EXPORTER -u OTEL_LOGS_EXPORTER -u OTEL_METRICS_EXPORTER -u DD_AGENT_HOST \
  ./node_modules/.bin/mocha packages/dd-trace/test/plugins/plugin-structure.spec.js
```

Result: exit `0`; `171 passing`, `0 failing`, `0 pending`.

Log: `32-attempts/plugin-structure.log`.

## Coverage integrity

The four changed behavioral spec files contain 876 added lines and zero deleted
lines relative to original base `372e5eb61c4c6a13662ad2f8780a87275b50314d`:

```text
192  0  packages/datadog-plugin-genkit/test/index.spec.js
608  0  packages/datadog-plugin-genkit/test/llmobs.spec.js
49   0  packages/dd-trace/test/opentelemetry/context_manager.spec.js
27   0  packages/dd-trace/test/opentelemetry/tracer.spec.js
```

A focused scan found no `describe.skip`, `it.skip`, `test.skip`, `.only`,
`xit`, or `xdescribe`, and the base diff contains no deleted test declaration.
No test was deleted, skipped, weakened, or mocked away.

## Frozen source integrity

The source hash command excludes generated pipeline/evidence artifacts:

```sh
git diff 372e5eb61c4c6a13662ad2f8780a87275b50314d -- . \
  ':(exclude).dd-apm-pipeline/**' ':(exclude).dd-apm-evidence/**' | sha256sum
```

Before tests: `2f18329cc57421c538109e8fab5a216cd52a6f36a1ba2d1d3d547a3948bf1422`.

After tests: `2f18329cc57421c538109e8fab5a216cd52a6f36a1ba2d1d3d547a3948bf1422`.

Full integrity output: `32-attempts/integrity-and-coverage.log`.

## Gate decision

Stage 32 passes. Stage 33 is authorized on this exact frozen source hash.
