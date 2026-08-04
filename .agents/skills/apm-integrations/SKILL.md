---
name: apm-integrations
description: |
  Use when adding, debugging, fixing, or modifying instrumentation and plugins
  for third-party libraries in dd-trace-js. Triggers: "add a new integration",
  "instrument a library", any *Plugin base class (Tracing/Database/Cache/
  Client/Server/Consumer/Producer/Composite), "addHook", "shimmer.wrap",
  "orchestrion", "bindStart"/"bindFinish", "diagnostic channel", "runStores",
  "subscriber cardinality", "channel.publish gate", "read upstream source",
  "reference plugin".
---

# APM Integrations

dd-trace-js provides automatic tracing for 100+ third-party libraries. Each integration consists of two decoupled layers communicating via Node.js diagnostic channels.

## Architecture

```text
┌──────────────────────────┐     diagnostic channels      ┌─────────────────────────┐
│     Instrumentation      │ ──────────────────────────▶  │        Plugin           │
│ datadog-instrumentations │    apm:<name>:<op>:start     │  datadog-plugin-<name>  │
│                          │    apm:<name>:<op>:finish    │                         │
│ Hooks into library       │    apm:<name>:<op>:error     │ Creates spans, sets     │
│ methods, emits events    │                              │ tags, handles errors    │
└──────────────────────────┘                              └─────────────────────────┘
```

`finish` above is the legacy manual-channel completion event. `tracingChannel`
and Orchestrion use `end` / `asyncEnd`, as described below.

**Instrumentation** (`packages/datadog-instrumentations/src/`):
Hooks into a library's internals and publishes events with context data to named diagnostic channels. Has zero knowledge of tracing — only emits events.

**Plugin** (`packages/datadog-plugin-<name>/src/`):
Subscribes to diagnostic channel events and creates APM spans with service name, resource, tags, and error metadata. Extends a base class providing lifecycle management.

Both layers are always needed for a new integration.

## Instrumentation: Orchestrion First

**Orchestrion is the required default when the work exists as a source function.** It rewrites matched CJS/ESM source from JavaScript config, avoiding runtime monkey-patching and ESM's static-binding traps. Start there for top-level declarations, class/object methods, named expressions, and assignments to named receivers. Use shimmer only when the work is created entirely at runtime or the required argument/result mutation cannot happen from Orchestrion's subscriber lifecycle.

Config lives in `packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/<name>.js`. See [Orchestrion Reference](references/orchestrion.md) for the full config format and examples.

### When Shimmer Is Necessary Instead

Shimmer (`addHook` + `shimmer.wrap`) should **only** be used when orchestrion cannot handle the pattern. When using shimmer, **always include a code comment explaining why orchestrion is not viable.** Valid reasons:

- **Dynamic method interception** — methods created at runtime or on prototype chains that orchestrion's static analysis cannot reach
- **Factory results that cannot be substituted** — `end` can replace synchronous results and `asyncEnd` can replace native-Promise results; shimmer remains necessary for Promise subclasses, userland thenables, or APIs that require the original result's identity
- **Pre-lifecycle argument modification** — arguments must be changed before Orchestrion's `bindStart` / subscribers can run

If none of these apply, use orchestrion. For shimmer patterns, refer to existing shimmer-based instrumentations in the codebase (e.g., `packages/datadog-instrumentations/src/pg.js`). Always try to use Orchestrion when beginning a new integration!

## Plugin Base Classes

Plugins extend a base class matching the library type. The base class provides automatic channel subscriptions, span lifecycle, and type-specific tags.

```text
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

## Read Upstream Source First

Touching `packages/datadog-instrumentations/src/<lib>.js`, its plugin counterpart, or any orchestrion config — for any reason — read the upstream library's source first. Memory of an SDK's contract drifts faster than the SDK; comments in the wrap go stale every minor version; cross-version diffs surface contract changes guessing misses (lazy → eager attachment, mode-exclusive APIs, new error paths).

Two ways to fetch the source locally:

1. **Shallow clone** the installed version:

  ```bash
  git clone --depth 1 --branch v<x.y.z> https://github.com/<org>/<repo>.git /tmp/<lib>-versions/v<x.y.z>
  ```

1. **`npm pack`** when the published runtime artifact is what matters:

  ```bash
  cd /tmp/<lib>-versions && npm pack <lib>@<x.y.z>
  tar -xzf <lib>-<x.y.z>.tgz -C v<x.y.z> --strip-components=1
  ```

Read the file the wrap hooks, the base classes the hooked methods inherit from, and files the wrap doesn't currently touch — a public method, an internal channel, or a metadata field the current instrumentation skipped often gives a cleaner hook (e.g., kafka `cluster.brokerPool.metadata.clusterId`, couchbase `tracingChannel`).

## Key Concepts

### The `ctx` Object

Context flows from instrumentation to plugin:

- **Orchestrion**: automatically provides `ctx.arguments` (method args) and `ctx.self` (instance)
- **Shimmer**: instrumentation sets named properties (`ctx.sql`, `ctx.client`, etc.)
- **Plugin sets**: `ctx.currentStore` (span), `ctx.parentStore` (parent span)
- **On completion**: `ctx.result` or `ctx.error`

### Channel Event Lifecycle

- `runStores()` for **start** events — establishes async context (always)
- `publish()` for **completion/error** events — notification only
- `hasSubscribers` guard — skip publish/subscriber work when no plugin listens; orchestrion still pays wrapper setup in current templates
- When shimmer is necessary, prefer `tracingChannel` (from `dc-polyfill`) over manual channels — it provides `start/end/asyncStart/asyncEnd/error` events automatically

### Channel Prefix Patterns

- **Orchestrion**: `tracing:orchestrion:<npm-package>:<channelName>` (set via `static prefix`)
- **Shimmer + `tracingChannel`** (preferred): `tracing:apm:<name>:<operation>` (set via `static prefix`)
- **Shimmer + manual channels** (legacy): `apm:{id}:{operation}` (default, no `static prefix` needed)

### `bindStart` and completion handlers

Use `bindStart` to create the span and return its store. Finish in the event the instrumentation emits: usually `end` for synchronous work, `asyncEnd` for promises/callbacks, and `finish` only for legacy instrumentations that publish it. Orchestrion does not publish `finish`.

### Subscriber Cardinality (`channel.publish` position)

When relocating a `channel.publish` call behind a dedupe gate, depth filter, cache-hit return, or any short-circuit, the question is not *"is the publish still there?"* but *"what cardinality does each downstream subscriber need?"*. Subscribers split into two camps that look identical from inside the publish site:

- **Once per first occurrence** — tracing plugins that dedupe spans, distinct-path metrics. Safe behind a dedupe gate.
- **Once per call** — IAST taint-tracking (mutates each call's `args` object by reference), AppSec WAF subscribers that block/log per invocation, anything walking payload identity. Drops data silently when cardinality falls below one-per-call.

Before adding or moving a gate in front of a publish, grep the repo for the channel name, list its subscribers, decide per-subscriber whether the new position preserves the cardinality each needs. When cardinalities diverge, split the publish into a pre-gate (per-call) and a post-gate (per-first-occurrence) call.

## Reference Integrations

**Always read 1-2 references of the same type before writing or modifying code.**

| Library Type | Plugin | Instrumentation | Base Class |
| --- | --- | --- | --- |
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

1. **Investigate** — Read the upstream library's source (see [Read Upstream Source First](#read-upstream-source-first)). Read 1-2 reference integrations of the same type (see table above). Understand the instrumentation and plugin patterns before writing code.
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
- **[Orchestrion Reference](references/orchestrion.md)** — JavaScript config format, channel naming, function kinds, plugin subscription
- **[Plugin Patterns](references/plugin-patterns.md)** — `startSpan()` API, `ctx` object details, `CompositePlugin`, channel subscriptions, code style
- **[Testing](references/testing.md)** — Unit test and ESM integration test templates
- **[Reference Plugins](references/reference-plugins.md)** — All plugins organized by base class
