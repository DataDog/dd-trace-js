# Implementation Guide

## Source-First Investigation

Before designing a hook, read the runtime or framework source for the exact version range being supported. Identify:

- how user handlers are registered or exported;
- whether the runtime supports promises, callbacks, sync handlers, streaming, or generators;
- where request/event/context objects first cross into user code;
- whether timeout or shutdown signals are observable;
- which fields carry distributed trace context.

Do not rely on docs alone when the runtime implementation is available.

## Instrumentation Layer

Prefer Orchestrion when a static require/import hook can describe the patch. Use shimmer or a runtime wrapper only
when the platform resolves handlers dynamically or requires wrapping user exports after module loading.

Instrumentation should stay trace-agnostic:

- publish start, finish, async finish, error, and timeout events through diagnostic channels;
- keep event payloads stable and minimal;
- use `runStores()` or Orchestrion binding for start events that need async context;
- avoid tracer imports in instrumentation packages.

Preserve event publication needed by non-tracing subscribers. Do not gate all publishes only on tracing-plugin state.

## Plugin Layer

Serverless root plugins usually extend `TracingPlugin`:

```js
class MyServerlessPlugin extends TracingPlugin {
  static id = 'my-serverless'
  static operation = 'invoke'
  static kind = 'server'
  static type = 'serverless'
  static prefix = 'tracing:datadog:my:serverless'

  bindStart (ctx) {
    const span = this.startSpan(this.operationName(), {
      childOf: ctx.parent || null,
      service: this.serviceName(),
      type: 'serverless',
      meta: {
        'component': 'my-serverless'
      }
    }, ctx)

    ctx.currentStore = ctx.currentStore || {}
    ctx.currentStore.span = span

    return ctx.currentStore
  }
}
```

Use local plugin patterns over this sketch when they differ. The key contract is that the invocation span is the root
serverless span and is finished exactly once.

## HTTP Triggers

For HTTP-triggered functions, inspect `packages/datadog-plugin-azure-functions/src/index.js` before coding. Reuse the
web helper path when the trigger maps to request/response semantics:

- `web.patch(req)`
- `web.startServerlessSpanWithInferredProxy(...)`
- `web.finishAll(webContext, 'serverless')`
- `web.normalizeConfig(config)`

This keeps inferred proxy spans, HTTP tags, blocking behavior, and AppSec expectations aligned with the rest of the
tracer.

## Non-HTTP And Batch Triggers

For queue, event, and batch triggers:

- extract trace context from trigger metadata or message attributes at the boundary;
- use a single invocation span for the function execution;
- add span links when multiple upstream contexts are present;
- tag trigger type, resource, region/account/project identifiers, and runtime metadata with existing tag naming
  patterns where possible;
- avoid high-cardinality resource names unless existing serverless integrations already use that shape.

## Registration And Naming

For normal plugin-backed integrations, update:

- `packages/dd-trace/src/plugins/index.js`
- `packages/dd-trace/src/service-naming/schemas/v0/serverless.js`
- `packages/dd-trace/src/service-naming/schemas/v1/serverless.js`
- docs and TypeScript config files only when user-facing config changes

For AWS Lambda bootstrap changes, read `packages/dd-trace/src/lambda/index.js`,
`packages/dd-trace/src/lambda/runtime/patch.js`, and `packages/dd-trace/src/lambda/handler.js` before editing.

## Failure Handling

Never let instrumentation errors crash user functions. Catch and log unexpected instrumentation failures, then let the
handler continue when possible. Prefer deterministic state flags over timer races so spans finish once even when
timeout and handler completion happen close together.
