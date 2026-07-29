# Testing serverless integrations

Exercise the runtime-facing entry point. A direct call to an exported helper does not prove handler registration,
loader behavior, context binding, or process-lifecycle handling.

## Choose the real local path

- Azure Functions: launch `azure-functions-core-tools`, invoke the fixture endpoint, and assert traces through
  `FakeAgent`.
- Azure queue, event, database, and durable triggers: use the emulator and service setup from
  `.github/workflows/serverless.yml`.
- AWS Lambda: exercise `DD_LAMBDA_HANDLER` registration and the wrapped handler under `packages/dd-trace/test/lambda/`.

Copy the nearest fixture and workflow job. The provider runtime decides the directory layout, launcher, environment,
and completion forms; do not replace them with a hand-built fake unless the real launcher cannot reach the branch.

## Cases

Cover only lifecycle forms and trigger shapes the supported runtime exposes:

- success, thrown error, and rejected promise;
- callback or synchronous completion when that runtime version supports it;
- timeout or crash-flush behavior when the runtime exposes a testable signal;
- disabled instrumentation and unrelated plugin loading;
- child-span parenting under the invocation span;
- each distributed-context carrier and batch-link cardinality;
- HTTP tags, inferred proxy spans, status, and AppSec behavior where applicable;
- exactly one finish for each started span.

Assert on the invocation span itself: the operation name the naming schema produces (`azure.functions.invoke` for
both Azure plugins today), `type: 'serverless'`, the serverless service name, the platform tags the plugin sets
(`aas.function.name`, `aas.function.trigger`), a low-cardinality resource, and one link per upstream context.

Use fake timers for timeout scheduling. Assert the last safe point and first timeout point when changing a deadline.

## Commands

Unset OpenTelemetry exporters before plugin tests so traces reach `FakeAgent`:

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
```

Run a serverless plugin with its version fixtures:

```bash
PLUGINS="<name>" npm run test:plugins:ci
```

For a single already-installed spec:

```bash
./node_modules/.bin/mocha --timeout 60000 packages/datadog-plugin-<name>/test/<path>.spec.js
```

Service-backed plugins need the `SERVICES`, containers, readiness checks, and setup steps from their
`.github/workflows/serverless.yml` job. Running only `docker compose up` may omit emulator configuration copied by
the workflow.

Run Lambda specs directly:

```bash
./node_modules/.bin/mocha packages/dd-trace/test/lambda/*.spec.js
```

## Coverage and deployed checks

Sandboxed runtime processes do not contribute to nyc coverage. Add same-process coverage for changed production
branches when the integration test cannot cover them in-process.

Use deployed verification only for a provider-owned behavior the real local runtime or emulator cannot reproduce,
such as freeze timing or platform-injected metadata. Record the runtime version, region, invocation identifier,
trace query, expected parentage, and cleanup command. Confirm the trace reached Datadog; provider logs alone do not
prove writer or flush behavior.

## Localize a failure

The trace shape names the layer, so read it before rerunning:

- no invocation span but the handler ran: registration or hook resolution;
- invocation span without children: async context binding;
- children without an invocation span: span start or parent extraction;
- more than one invocation span: handler wrapped twice, or a second completion path finishing again;
- spans in the process but no trace in Datadog: writer or flush against the runtime lifecycle.
