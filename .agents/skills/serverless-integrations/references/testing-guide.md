# Testing Guide

Serverless integration tests need both local behavioral coverage and deployed probe coverage when a platform
integration is added or materially changed.

## Local Test Matrix

Cover the runtime lifecycle, not only the happy path:

- successful synchronous handler;
- successful promise/async handler;
- callback-style completion when the runtime supports callbacks;
- thrown error and rejected promise;
- timeout or near-timeout path when observable;
- disabled instrumentation path;
- child span parenting under the invocation span;
- distributed context extraction for each trigger type;
- span links for batch triggers with multiple upstream contexts;
- HTTP trigger behavior, including inferred proxy spans, when applicable.

Assert that the invocation span has:

- operation name ending in `.invoke` or the established local pattern;
- `type = 'serverless'`;
- `span.kind = 'server'` where the plugin framework sets it;
- expected service name from serverless service naming;
- component/runtime tags;
- resource naming that matches existing serverless conventions.

## Commands

Plugin tests in dd-trace-js must run with OpenTelemetry exporter environment variables unset:

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
PLUGINS="<plugin-name>" npm run test:plugins
```

For a single spec:

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
./node_modules/.bin/mocha packages/datadog-plugin-<name>/test/index.spec.js
```

Use targeted `--grep` when verifying a specific failing case. Do not run the full root test suite.

## Test Shape

Prefer blackbox tests that exercise the runtime-facing API or fixture app. Avoid production exports that exist only
for tests. When a fake runtime is needed, keep it faithful to the real runtime's handler registration and completion
semantics.

Use fake timers for timeout logic. Do not wait for real time to pass in unit tests.

## Regression Rules

Every bug fix should include:

- the failing lifecycle path;
- sibling lifecycle paths that share the same completion or error code;
- a disabled-instrumentation case if the bug touches registration or event publication.
