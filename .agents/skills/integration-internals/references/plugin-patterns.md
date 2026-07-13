# Plugin Writing Patterns

Plugins live in `packages/datadog-plugin-{name}/src/` and subscribe to diagnostic channel events to create spans.

## Base Class Hierarchy

```
Plugin
├── CompositePlugin
└── TracingPlugin
    ├── ServerPlugin
    ├── OutboundPlugin
    │   ├── ClientPlugin
    │   │   └── StoragePlugin
    │   │       └── DatabasePlugin
    │   └── CachePlugin
    ├── ProducerPlugin
    ├── ConsumerPlugin
    ├── LogPlugin
    └── WebPlugin
        └── RouterPlugin
```

## Base Class Selection

| Library Type | Base Class | Examples |
|--------------|------------|----------|
| Database client | `DatabasePlugin` | pg, mysql, mongodb |
| Cache client | `CachePlugin` | redis, memcached, ioredis |
| HTTP client | `ClientPlugin` | axios, fetch, undici |
| HTTP server | `ServerPlugin` | http server |
| Web framework routing | `RouterPlugin` | express, fastify, koa |
| Message producer | `ProducerPlugin` | kafkajs producer |
| Message consumer | `ConsumerPlugin` | kafkajs consumer |
| Multiple features | `CompositePlugin` | express (tracing + code origin) |
| Logging | `LogPlugin` | winston, pino, bunyan |

**Wrong base class = complex workarounds.** If you're fighting the base class, you probably chose wrong.

## Base Class Features

### DatabasePlugin
- `injectDbmComment(span, queryText)` — DBM trace injection
- Pre-configured for `db.*` tags
- Handles connection info extraction

### CachePlugin
- Cache-specific tags and metrics

### ClientPlugin
- Peer service detection
- Distributed tracing header injection

### ProducerPlugin / ConsumerPlugin
- DSM (Data Streams Monitoring) integration
- Context propagation in messages
- Messaging-specific tags

### LogPlugin
- Injects trace context (dd.trace_id, dd.span_id) into log records
- Does NOT create spans

## Key Files

| File | Purpose |
|------|---------|
| `datadog-instrumentations/src/helpers/hooks.js` | Package → instrumentation mapping |
| `datadog-instrumentations/src/helpers/instrument.js` | addHook, channel, tracingChannel APIs |
| `dd-trace/src/plugins/plugin.js` | Base Plugin class |
| `dd-trace/src/plugins/tracing.js` | TracingPlugin with span helpers |
| `dd-trace/src/plugins/database.js` | DatabasePlugin with DBM features |
| `dd-trace/src/plugins/index.js` | Plugin registration |

## Registration

```javascript
// packages/dd-trace/src/plugins/index.js
module.exports = {
  get mylib () { return require('../../../datadog-plugin-mylib/src') },
}
```

## Code Style: Keep It Simple

**Your plugin should look like production plugins.**

| Aspect | Avoid | Prefer |
|--------|-------|--------|
| Subscriptions | Manual `addSub`/`addBind` calls | Inherit from base class via `static prefix`/`static operation` |
| Tag extraction | Complex fallback chains | Simple, direct access |
| finish() | Custom logic | Inherited from base |
| Channel routing | `if (channel.includes(...))` | One channel per operation via CompositePlugin |

Process:
1. Find a similar working plugin
2. Copy its structure exactly
3. Only change what's specific to your library

## Reference Implementations

| Type | Reference Plugin |
|------|------------------|
| Database | `datadog-plugin-pg` |
| Cache | `datadog-plugin-redis` |
| HTTP client | `datadog-plugin-fetch` |
| Messaging | `datadog-plugin-kafkajs` |
| Web framework | `datadog-plugin-express` |
| Orchestrion-based | `datadog-plugin-langchain` |

## Debugging ctx

Add temporary logging to see what's available:
```javascript
bindStart(ctx) {
  console.log('=== ctx debug ===')
  console.log('Keys:', Object.keys(ctx))
  console.log('arguments:', ctx.arguments)
  console.log('self:', ctx.self?.constructor?.name)
  console.log('self keys:', Object.keys(ctx.self || {}))
  // Remove after debugging!
}
```
