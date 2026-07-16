# Testing Guide

Serverless integration tests need both local behavioral coverage and deployed verification when a platform integration
is added or materially changed.

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

## Deployed Verification

Local tests cannot prove that a serverless integration works in the real provider lifecycle. When a platform
integration is added or materially changed, include a deployed verification plan.

In this guide, a probe is a temporary deployed sample function or app used to verify provider behavior and Datadog
ingestion. It is not a dd-trace-js runtime feature.

Use the narrowest mode that answers the risk:

- Manual: document commands for a maintainer to deploy, invoke, query, and clean up.
- Semi-automated: provide scripts that deploy and invoke, while the maintainer supplies credentials.
- CI-automated: run only when repository policy and provider credentials already support it.

Do not require permanent infrastructure for deployed verification unless the project already has that pattern.

The deployed app should:

- use the dd-trace-js version under test;
- enable the new serverless integration explicitly when needed;
- emit one deterministic child span inside the handler;
- support success and error invocations;
- include a unique probe id in tags, for example `dd.apm.probe_id:<uuid>`;
- keep resource names and payloads low-cardinality;
- clean up provider resources after the run.

The verification must confirm traces reached Datadog, not only that invocation logs exist. Query by the unique probe
id and assert:

- one invocation root span exists per invocation;
- the root span has `type:serverless` and the expected service/resource;
- the deterministic child span is parented under the invocation span;
- errors are tagged on failing invocations;
- distributed context or span links appear for trigger types that carry upstream context;
- no duplicate root spans are emitted for one invocation.

If Datadog trace search is eventually consistent, poll with a bounded timeout and report the query window used.

Record the provider, region, runtime version, deployed app commit or package version, invocation ids, probe id, and
Datadog query used. When the verification is manual, include the expected trace shape and cleanup command in the
workflow output or PR description.

Classify deployed verification failures by layer:

- deployment failed: provider or packaging issue;
- invocation failed before user handler: runtime wrapper or bootstrap issue;
- logs show spans but Datadog has no trace: writer, flush, or mini-agent issue;
- root span exists without children: async context binding issue;
- children exist without root: invocation start or parent extraction issue;
- duplicate roots: handler wrapping or completion path issue.
