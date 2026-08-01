# Plugin patterns

Read the chosen base class before copying a shape. This reference records the contracts that differ across bases;
the parent [channel and plugin contract](../SKILL.md#channel-and-plugin-contract) owns the common behavior.

## `startSpan` signatures

| Base | Call shape | Span name owner |
| --- | --- | --- |
| `TracingPlugin` | `startSpan(name, options, ctx)` | Caller |
| `InboundPlugin` / `ServerPlugin` | `startSpan(name, options, ctx)` | Caller |
| `OutboundPlugin` / `ClientPlugin` / `StoragePlugin` / `DatabasePlugin` | `startSpan(name, options, ctx)` | Caller |
| `CachePlugin` | `startSpan(options, ctx)` | `operationName()` |
| `ProducerPlugin` | `startSpan(options, ctx)` | `operationName()` |
| `ConsumerPlugin` | `startSpan(options, ctx)` | `operationName()` |

Passing a name to the final three shifts every argument and breaks span creation. Their `type`, `kind`, service,
and operation defaults are behavior, not convenience; override only what the integration contract requires.

## Context ownership

Instrumentation owns the fields describing the library call. Orchestrion supplies `arguments`, `moduleVersion`,
and later `result` or `error`. It supplies `self` at start for non-arrow targets and only by `end` for arrow
targets. Shimmer instrumentation names its own fields. The plugin may read those fields but must not reach back
into the library to rediscover data the event should carry.

`startSpan(..., ctx)` writes:

- `ctx.parentStore`: the store active before span creation;
- `ctx.currentStore`: a new store containing the span.

Return `ctx.currentStore` from `bindStart`. `InboundPlugin` and `OutboundPlugin` return `ctx.parentStore` from
`bindFinish` for instrumentations that publish `finish`.

## Completion mapping

| Instrumentation behavior | Plugin method | Reason |
| --- | --- | --- |
| Orchestrion `Sync` | `end(ctx)` | `ctx.result` or `ctx.error` exists when the call returns |
| Orchestrion `Async` / `Auto`, sync return | `end(ctx)` | `ctx.result` exists when the call returns |
| Orchestrion promise or callback completion | `asyncEnd(ctx)` | The operation has settled |
| `tracingChannel.tracePromise()` / `traceCallback()` | `asyncEnd(ctx)` | The channel reports asynchronous settlement |
| Event-driven shimmer wrapper | Method for its terminal event | The returned object's event owns completion |
| Legacy manual `finish` channel | `finish(ctx)` | The instrumentation explicitly publishes `finish` |

An `Async` or `Auto` wrapper also publishes `end` when the original call returns. If a plugin handles both the
synchronous-return and asynchronous branches from `end` and `asyncEnd`, keep the presence gate so an unsettled
async call is not closed early:

```js
end (ctx) {
  if (!Object.hasOwn(ctx, 'result') && !Object.hasOwn(ctx, 'error')) return
  this.finish(ctx)
}
```

Do not add this gate to a plugin that already finishes exclusively from `asyncEnd`; it would be dead code.

## Role-specific examples

### Database or generic client

```js
bindStart (ctx) {
  const { client, statement } = ctx
  this.startSpan(this.operationName(), {
    service: this.serviceName({ pluginConfig: this.config }),
    resource: statement,
    type: 'sql',
    kind: 'client',
    meta: {
      component: '<name>',
      'db.type': '<system>',
      'out.host': client.host,
    },
  }, ctx)
  return ctx.currentStore
}
```

### Cache

```js
bindStart (ctx) {
  this.startSpan({
    resource: ctx.command,
    service: this.serviceName({ pluginConfig: this.config }),
    meta: {
      component: '<name>',
      'db.type': '<system>',
    },
  }, ctx)
  return ctx.currentStore
}
```

### Producer or consumer

```js
bindStart (ctx) {
  this.startSpan({
    resource: ctx.destination,
    meta: {
      component: '<name>',
      'messaging.destination.name': ctx.destination,
      'messaging.system': '<system>',
    },
  }, ctx)
  return ctx.currentStore
}
```

Populate peer-service, DSM, propagation, and schema-specific fields by copying the closest current role-specific
plugin. The snippets only demonstrate the signature boundary.

## Composite plugins

Use `CompositePlugin` when operations require separate prefixes, bases, or configuration keys:

```js
'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ConsumerPlugin = require('./consumer')
const ProducerPlugin = require('./producer')

class ExamplePlugin extends CompositePlugin {
  static id = '<name>'

  static plugins = {
    consumer: ConsumerPlugin,
    producer: ProducerPlugin,
  }
}

module.exports = ExamplePlugin
```

Each child is a complete plugin with its own prefix or operation. `configure()` merges the parent configuration
with `config[childName]`; `false` disables that child. Do not route several channel names through conditionals in
one `bindStart` when independent child plugins express the contract.

## Errors

`TracingPlugin.error(ctx)` tags `ctx.error` on `ctx.currentStore.span`. Override it only when the library reports a
non-error through the error channel, when extra tags are required, or when an integration-owned abort must not mark
the span. Keep instrumentation exceptions inside the instrumentation boundary so plugin logic cannot crash the
application.

## Multiple prefixes

`TracingPlugin` subscribes only to `this.constructor.prefix`. When several npm packages publish the same logical
operation, override `addTraceSubs()`, call `super.addTraceSubs()`, and register the same six event and binding names
for each extra prefix. Do not add an unused `static extraPrefixes` field; the base class does not read it. The
current reference is `packages/datadog-plugin-graphql/src/execute.js`.
