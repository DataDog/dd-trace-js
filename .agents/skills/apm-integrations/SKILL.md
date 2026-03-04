---
name: apm-integrations
description: |
  This skill should be used when the user asks to "add a new integration",
  "instrument a library", "add instrumentation for",
  "create instrumentation", "new dd-trace integration",
  "add tracing for", "TracingPlugin", "DatabasePlugin", "CachePlugin",
  "ClientPlugin", "ServerPlugin", "CompositePlugin", "ConsumerPlugin",
  "ProducerPlugin", "addHook", "shimmer.wrap", "orchestrion",
  "bindStart", "bindFinish", "startSpan", "diagnostic channel",
  "runStores", "reference plugin", "example plugin", "similar integration",
  or needs to build, modify, or debug the instrumentation and plugin layers
  for a third-party library in dd-trace-js.
---

# APM Integrations

dd-trace-js provides automatic tracing for 100+ third-party libraries. Each integration consists of two decoupled layers communicating via Node.js diagnostic channels.

## Architecture

```
┌──────────────────────────┐     diagnostic channels      ┌─────────────────────────┐
│     Instrumentation      │ ──────────────────────────▶  │        Plugin           │
│ datadog-instrumentations │    apm:<name>:<op>:start     │  datadog-plugin-<name>  │
│                          │    apm:<name>:<op>:finish    │                         │
│ Hooks into library       │    apm:<name>:<op>:error     │ Creates spans, sets     │
│ methods, emits events    │                              │ tags, handles errors    │
└──────────────────────────┘                              └─────────────────────────┘
```

**Instrumentation** (`packages/datadog-instrumentations/src/`):
Hooks into a library's internals and publishes events with context data to named diagnostic channels. Has zero knowledge of tracing — only emits events.

**Plugin** (`packages/datadog-plugin-<name>/src/`):
Subscribes to diagnostic channel events and creates APM spans with service name, resource, tags, and error metadata. Extends a base class providing lifecycle management.

Both layers are always needed for a new integration.

## Instrumentation: Orchestrion First

**Orchestrion is the required default for all new instrumentations.** It is an AST rewriter that automatically wraps methods via JSON configuration, with correct CJS and ESM handling built in. Orchestrion handles ESM code far more reliably than traditional shimmer-based wrapping, which struggles with ESM's static module structure.

Config lives in `packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/<name>.js`. See [Orchestrion Reference](references/orchestrion.md) for the full config format and examples.

### When Shimmer Is Necessary Instead

Shimmer (`addHook` + `shimmer.wrap`) should **only** be used when orchestrion cannot handle the pattern. When using shimmer, **always include a code comment explaining why orchestrion is not viable.** Valid reasons:

- **Dynamic method interception** — methods created at runtime or on prototype chains that orchestrion's static analysis cannot reach
- **Factory patterns** — wrapping return values of factory functions
- **Argument modification** — instrumentations that need to mutate arguments before the original call

If none of these apply, use orchestrion. For shimmer patterns, refer to existing shimmer-based instrumentations in the codebase (e.g., `packages/datadog-instrumentations/src/pg.js`). Always try to use Orchestrion when beginning a new integration!

## Plugin Base Classes

Plugins extend a base class matching the library type. The base class provides automatic channel subscriptions, span lifecycle, and type-specific tags.

```
Plugin
├── CompositePlugin              — Multiple sub-plugins (produce + consume)
├── LogPlugin                    — Log correlation injection (no spans)
├── WebPlugin                    — Base web plugin
│   └── RouterPlugin             — Web frameworks with middleware
└── TracingPlugin                — Base for all span-creating plugins
    ├── InboundPlugin            — Inbound calls
    │   ├── ServerPlugin         — HTTP servers
    │   └── ConsumerPlugin       — Message consumers (DSM)
    └── OutboundPlugin           — Outbound calls
        ├── ProducerPlugin       — Message producers (DSM)
        └── ClientPlugin         — HTTP/RPC clients
            └── StoragePlugin    — Storage systems
                ├── DatabasePlugin   — Database clients (DBM, db.* tags)
                └── CachePlugin      — Key-value caches
```

**Wrong base class = complex workarounds.** Always match the library type to the base class.

## Key Concepts

### The `ctx` Object
Context flows from instrumentation to plugin:

- **Orchestrion**: automatically provides `ctx.arguments` (method args) and `ctx.self` (instance)
- **Shimmer**: instrumentation sets named properties (`ctx.sql`, `ctx.client`, etc.)
- **Plugin sets**: `ctx.currentStore` (span), `ctx.parentStore` (parent span)
- **On completion**: `ctx.result` or `ctx.error`

### Channel Event Lifecycle
- `runStores()` for **start** events — establishes async context (always)
- `publish()` for **finish/error** events — notification only
- `hasSubscribers` guard — skip instrumentation when no plugin listens (performance fast path)
- When shimmer is necessary, prefer `tracingChannel` (from `dc-polyfill`) over manual channels — it provides `start/end/asyncStart/asyncEnd/error` events automatically

### Channel Prefix Patterns
- **Orchestrion**: `tracing:orchestrion:<npm-package>:<channelName>` (set via `static prefix`)
- **Shimmer + `tracingChannel`** (preferred): `tracing:apm:<name>:<operation>` (set via `static prefix`)
- **Shimmer + manual channels** (legacy): `apm:{id}:{operation}` (default, no `static prefix` needed)

### `bindStart` / `bindFinish`
Primary plugin methods. Base classes handle most lifecycle; often only `bindStart` is needed to create the span and set tags.

## Reference Integrations

**Always read 1-2 references of the same type before writing or modifying code.**

| Library Type | Plugin | Instrumentation | Base Class |
|---|---|---|---|
| Database | `datadog-plugin-pg` | `src/pg.js` | `DatabasePlugin` |
| Cache | `datadog-plugin-redis` | `src/redis.js` | `CachePlugin` |
| HTTP client | `datadog-plugin-fetch` | `src/fetch.js` | `HttpClientPlugin` (extends `ClientPlugin`) |
| Web framework | `datadog-plugin-express` | `src/express.js` | `RouterPlugin` |
| Message queue | `datadog-plugin-kafkajs` | `src/kafkajs.js` | `Producer`/`ConsumerPlugin` |
| Orchestrion | `datadog-plugin-langchain` | `rewriter/instrumentations/langchain.js` | `TracingPlugin` |

For the complete list by base class, see [Reference Plugins](references/reference-plugins.md).

## Debugging

- `DD_TRACE_DEBUG=true` to see channel activity
- Log `Object.keys(ctx)` in `bindStart` to inspect available context
- Spans missing → verify `hasSubscribers` guard; check channel names match between layers
- Context lost → ensure `runStores()` (not `publish()`) for start events
- ESM fails but CJS works → check `esmFirst: true` in hooks.js (or switch to orchestrion)

## Implementation Workflow

Follow these steps when creating or modifying an integration:

1. **Investigate** — Read 1-2 reference integrations of the same type (see table above). Understand the instrumentation and plugin patterns before writing code.
2. **Implement instrumentation** — Create the instrumentation in `packages/datadog-instrumentations/src/`. Use orchestrion for instrumentation. 
3. **Implement plugin** — Create the plugin in `packages/datadog-plugin-<name>/src/`. Extend the correct base class.
4. **Register** — Add entries in `packages/dd-trace/src/plugins/index.js`, `index.d.ts`, `docs/test.ts`, `docs/API.md`, and `.github/workflows/apm-integrations.yml`.
5. **Write tests** — Add unit tests and ESM integration tests. See [Testing](references/testing.md) for templates.
6. **Run tests** — Validate with:
   ```bash
   # Run plugin tests (preferred CI command — handles yarn services automatically)
   PLUGINS="<name>" npm run test:plugins:ci

   # If the plugin needs external services (databases, message brokers, etc.),
   # check docker-compose.yml for available service names, then:
  docker compose up -d <service>
   PLUGINS="<name>" npm run test:plugins:ci
   ```
7. **Verify** — Confirm all tests pass before marking work as complete.

## Reference Files

- **[New Integration Guide](references/new-integration-guide.md)** — Step-by-step guide and checklist for creating a new integration end-to-end
- **[Orchestrion Reference](references/orchestrion.md)** — JSON config format, channel naming, function kinds, plugin subscription
- **[Plugin Patterns](references/plugin-patterns.md)** — `startSpan()` API, `ctx` object details, `CompositePlugin`, channel subscriptions, code style
- **[Testing](references/testing.md)** — Unit test and ESM integration test templates
- **[Reference Plugins](references/reference-plugins.md)** — All plugins organized by base class
