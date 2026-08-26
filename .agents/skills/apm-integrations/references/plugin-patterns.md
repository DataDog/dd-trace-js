# Plugin Patterns

## Automatic Channel Subscriptions

Do not manually subscribe for an ordinary single-prefix plugin. `TracingPlugin` automatically subscribes to all
lifecycle events and routes them to matching plugin methods. Multiple module prefixes are the documented exception;
see [Orchestrion Plugin Subscription](orchestrion.md#plugin-subscription).

The channel prefix is determined by the instrumentation type. Node.js `tracingChannel` automatically adds a `tracing:` prefix to all sub-channel names.

| Instrumentation Type | `static prefix` | Example |
|---|---|---|
| **Orchestrion** | `'tracing:orchestrion:<npm-package>:<channelName>'` | `'tracing:orchestrion:bullmq:Queue_add'` |
| **Shimmer + `tracingChannel`** (preferred for shimmer) | `'tracing:apm:<name>:<operation>'` | `'tracing:apm:undici:fetch'` |
| **Shimmer + manual channels** (legacy) | omit — defaults to `apm:${id}:${operation}` | `apm:pg:query` |

When using shimmer, prefer `tracingChannel` over manual channels — it provides `start/end/asyncStart/asyncEnd/error` events automatically, consistent with how orchestrion works internally.

Define static properties, `bindStart`, and the completion handler matching the instrumentation lifecycle:

### Orchestrion Plugin (preferred)
```javascript
class MyPlugin extends TracingPlugin {
  static id = '<name>'
  static prefix = 'tracing:orchestrion:<npm-package>:Client_query'

  bindStart (ctx) {
    this.startSpan(this.operationName(), {
      resource: ctx.arguments?.[0],
      meta: { component: '<name>' }
    }, ctx)
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }
}
```

### Shimmer Plugin
```javascript
class MyPlugin extends DatabasePlugin {
  static id = '<name>'
  static operation = 'query'

  bindStart (ctx) {
    this.startSpan(this.operationName(), {
      resource: ctx.sql,
      meta: { component: '<name>' }
    }, ctx)
    return ctx.currentStore
  }
}
```

For synchronous Orchestrion targets, implement `end` instead of `asyncEnd`. Legacy manual-channel plugins normally
finish through the inherited `finish` handler. No manual subscription is needed unless one plugin serves multiple
channel prefixes.

## startSpan() API

```javascript
this.startSpan(name, options, ctx)
```

Options:
```javascript
{
  service: 'service-name',
  resource: 'SELECT * ...',
  type: 'sql',                // sql, web, cache, custom
  kind: 'client',             // client | server | producer | consumer
  meta: {                     // String tags
    component: 'mylib',
    'db.type': 'mysql',
  },
  metrics: {                  // Numeric tags
    'db.row_count': 42
  }
}
```

## The ctx Object

### Orchestrion-Based Instrumentation
```javascript
bindStart (ctx) {
  const firstArg = ctx.arguments?.[0]    // method arguments
  const instance = ctx.self               // 'this' context
  const config = ctx.self?.config
}
```

### Shimmer-Based Instrumentation
```javascript
bindStart (ctx) {
  const { sql, client, options } = ctx   // named properties set by instrumentation
}
```

### Common Properties (Set by Plugin)
```javascript
ctx.currentStore   // { span } — set by startSpan
ctx.parentStore    // { span } — parent context
ctx.result         // return value (on finish)
ctx.error          // thrown error (on error)
```

## CompositePlugin Pattern

For integrations with multiple operations (e.g., produce + consume, or multiple orchestrion methods):

```javascript
// src/index.js
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')

class MyPlugin extends CompositePlugin {
  static id = '<name>'

  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin
    }
  }
}

module.exports = MyPlugin
```

Create separate files in `src/` for each sub-plugin. Each sub-plugin gets its own `static prefix` (orchestrion) or `static operation` (shimmer).

For orchestrion integrations wrapping multiple methods, each method gets its own plugin class with a unique `static prefix`, then all are combined via `CompositePlugin`. See langchain for this pattern.

## Error Handling

Base classes handle errors automatically via `ctx.error`. Explicit handling is rarely needed:

```javascript
// Automatic — base class reads ctx.error
// Only override for custom error logic:
error (ctx) {
  const span = ctx.currentStore?.span
  if (span && ctx.error) {
    span.setTag('error', ctx.error)
  }
}
```

## The finish() Guard

If this guard exists in code, **never remove it**:
```javascript
finish (ctx) {
  if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return
  const span = ctx.currentStore?.span
  if (span) {
    super.finish(ctx)
  }
}
```

Ensures spans only close when the operation actually completes. Without it, spans close prematurely.

## Code Style

### DO
```javascript
class MyPlugin extends DatabasePlugin {
  static id = 'mylib'
  static operation = 'query'

  bindStart (ctx) {
    this.startSpan(this.operationName(), {
      resource: ctx.sql,
      meta: { component: 'mylib' }
    }, ctx)
    return ctx.currentStore
  }
}
```

### DON'T
```javascript
// Over-engineered — manual subscriptions, complex channel routing
class MyPlugin extends DatabasePlugin {
  constructor (...args) {
    super(...args)
    this.addSub('apm:mylib:query:start', ctx => this.start(ctx))  // Don't do this
    this.addSub('apm:mylib:query:finish', ctx => this.finish(ctx)) // Base class handles it
  }

  bindStart (ctx, channel) {
    if (channel.includes('foo')) { ... }  // Don't route by channel name
    else if (channel.includes('bar')) { ... }
  }
}
```

**Golden rule:** The plugin should look like production plugins. Copy from references, only change what's library-specific.
