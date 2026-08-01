# Serverless implementation guide

Use this guide after classifying the boundary in the parent skill. The normal path is a runtime-facing
instrumentation plus a plugin; the AWS Lambda bootstrap is a separate path.

## 1. Record the runtime contract

For every supported runtime version, record:

- where handlers are registered, resolved, and called;
- whether the runtime accepts sync, promise, callback, stream, or generator completion;
- the exact event, request, context, and result objects crossing the user-code boundary;
- timeout, shutdown, freeze, and crash signals the process can observe;
- distributed-context carriers and batch cardinality;
- whether the same handler can be registered or wrapped more than once.

Read the provider runtime source, the nearest in-repo integration, its real launcher test, and the owning workflow
job. Provider documentation alone does not settle the implementation lifecycle.

## 2. Choose the owner

Use a plugin-backed integration when a package API registers or invokes user handlers:

```text
runtime package → datadog-instrumentations wrapper → tracing channel → plugin → invocation span
```

Use the Lambda bootstrap only when changing handler resolution through `DD_LAMBDA_HANDLER`, the
`datadog-lambda-js` compatibility hook, runtime patching, or impending-timeout flushing:

```text
Lambda loader → dd-trace/src/lambda → runtime patch / timeout channel
```

Do not add an invocation span in the bootstrap; this dd-trace-js path does not own it.

## 3. Implement a plugin-backed invocation

### Instrumentation

Add or update `packages/datadog-instrumentations/src/<runtime>.js`. Keep it trace-agnostic and publish one context
object through the whole lifecycle. Establish the invocation context before user code with `runStores()` or a
tracing-channel operator.

Runtime-created registration normally requires shimmer. Wrap registration once, replace only the handler argument
or field, and forward every other argument. Use the operator matching the runtime's real completion contract; do
not add callback or stream branches the runtime does not support.

The Azure Functions reference uses `tracePromise()` because version 4 registers promise-returning handlers. Read
`packages/datadog-instrumentations/src/azure-functions.js` before adapting that pattern.

### Plugin

Add or update `packages/datadog-plugin-<runtime>/src/index.js`. Invocation plugins normally extend `TracingPlugin`
and set:

```js
static id = '<runtime>'
static operation = 'invoke'
static kind = 'server'
static type = 'serverless'
static prefix = 'tracing:<instrumentation-channel>'
```

In `bindStart(ctx)`:

1. Extract parent context before creating the span, or use `childOf: null` when the invocation must be a root.
2. Call `startSpan(this.operationName(), options, ctx)` so `currentStore` and `parentStore` stay canonical.
3. Use a low-cardinality resource based on function name and trigger type, never request or message identifiers.
4. Return `ctx.currentStore` so child instrumentation runs below the invocation.

Finish from the lifecycle event that proves user work completed. Use recorded state or an idempotent completion flag
when timeout and normal completion can race. Every started span must finish exactly once; a timer firing first is
not proof the handler finished.

### HTTP triggers

When the runtime exposes request/response semantics, use the shared web owner instead of reimplementing HTTP tags,
AppSec behavior, inferred proxies, or status handling:

- `web.patch(req)` creates the web context;
- `web.startServerlessSpanWithInferredProxy(...)` starts the invocation and optional proxy span;
- `web.finishAll(webContext, 'serverless')` finishes the related spans;
- `web.normalizeConfig(config)` keeps web configuration aligned.

Read `packages/datadog-plugin-azure-functions/src/index.js` for the complete ordering. An inferred proxy span may be
the trace root, so do not assert that every serverless invocation span has no parent.

### Queue, event, database, and batch triggers

Extract context from the carrier the runtime supplies. One invocation still gets one invocation span. When a batch
contains several valid upstream contexts, add one span link per context instead of choosing an arbitrary parent.

Use existing platform tag names. Message ids, request ids, object keys, event ids, and payload values must not enter
the resource name. Preserve per-call diagnostic-channel events required by AppSec, IAST, or telemetry even when the
tracing plugin is disabled.

## 4. Register naming and tests

For a plugin-backed serverless integration:

1. Register the instrumentation in `packages/datadog-instrumentations/src/helpers/hooks.js`.
2. Register the plugin getter in `packages/dd-trace/src/plugins/index.js`.
3. Add the plugin id to both `service-naming/schemas/v0/serverless.js` and `v1/serverless.js`.
4. Update both public type files only when the configuration is public and not v6-only.
5. Update `docs/API.md`, `docs/test.ts`, CODEOWNERS, and `.github/workflows/serverless.yml` as applicable.
6. Add the latest runtime package to the tracked version manifest.
7. Add a fixture launched by the real local runtime or emulator.

Use [Testing serverless integrations](testing-guide.md) for the lifecycle matrix and commands. Copy the nearest
workflow job; serverless emulators often need mounted configuration and readiness steps beyond `docker compose up`.

## 5. Change the Lambda bootstrap

Read these files as one path before editing:

- `packages/dd-trace/src/lambda/index.js`: instrumentation gate, handler resolution, and compatibility hook;
- `packages/dd-trace/src/lambda/runtime/patch.js`: runtime API patching;
- `packages/dd-trace/src/lambda/handler.js`: timeout scheduling and crash flush;
- `packages/dd-trace/test/lambda/`: registration, context, and handler tests.

Preserve the disabled-instrumentation gate and catch/log hook failures so instrumentation cannot stop handler
loading. Use fake timers for the flush deadline and test both the final safe point and first timeout point.

## Completion checklist

- [ ] Runtime versions, handler boundary, completion forms, carriers, and shutdown signals recorded.
- [ ] Plugin-backed and Lambda-bootstrap responsibilities remain separate.
- [ ] Invocation context is active before user code and every span finishes exactly once.
- [ ] HTTP triggers use the shared web owner; batch triggers link all valid upstream contexts.
- [ ] Resource names remain low-cardinality and instrumentation failures cannot escape.
- [ ] Naming schemas, runtime registration, types/docs, CODEOWNERS, workflow, and versions are updated as applicable.
- [ ] Real launcher/emulator tests cover success, errors, disabled behavior, parenting, and completion siblings.
- [ ] Focused tests, lint, and changed-line/branch coverage pass.
