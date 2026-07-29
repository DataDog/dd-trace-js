---
name: apm-integrations
description: |
  Use when adding, debugging, fixing, reviewing, or modifying instrumentation and plugins for third-party libraries
  in dd-trace-js. Requests include "add a new integration", "instrument a library", "add tracing for",
  "fix an instrumentation", "debug a plugin", "find a reference plugin", and "read upstream source". Also trigger
  on plugin base classes, addHook, shimmer, Orchestrion, diagnostic channels, bindStart, runStores, and channel
  publish gates.
---

# APM integrations

This skill owns the mechanics shared by APM, plugin-backed serverless, and LLMObs integrations: source inspection,
hook selection, the instrumentation/plugin boundary, registration, and generic tests. Specialized skills own only
their domain-specific behavior.

Use `serverless-integrations` when dd-trace-js owns the cloud function invocation itself, and `llmobs-integration` /
`llmobs-testing` when the change emits LLMObs spans.

## Architecture

Instrumentation under `packages/datadog-instrumentations/src/` observes the library and publishes trace-agnostic
diagnostic-channel events. A plugin under `packages/datadog-plugin-<name>/src/` subscribes to those events and owns
span naming, tags, parenting, errors, and completion. Keep tracer imports out of the instrumentation layer.

## Execution sequence

Follow the full sequence for a new APM or plugin-backed integration. Specialized skills use only the shared steps
their integration needs.

1. Read the upstream source and trace the public call through every supported build and completion form.
2. Choose the hook and plugin base, then read their implementations and one or two current integrations of that
   shape.
3. Add the instrumentation file and one `helpers/hooks.js` entry per npm package name. The plain form is
   `() => require('../<name>')`; `{ esmFirst: true, fn }` also hooks files below an ESM package entry point, and
   `{ serverless: false, fn }` skips hooks that must not load in serverless environments.
4. For Orchestrion, add its config and register it in `rewriter/instrumentations/index.js`.
5. Add the plugin package and the runtime getter in `packages/dd-trace/src/plugins/index.js`.
6. Register operation and service names in `service-naming/schemas/v0/<type>.js` and `v1/<type>.js` when the plugin
   or its base calls `operationName()` or `serviceName()`.
7. Configure versions and tests through [Testing integrations](references/testing.md).
8. Add the plugin to `index.d.ts` and `index.d.v5.ts` unless it is v6-only; `docs/API.md` needs both the
   `Available Plugins` entry and an `<h5 id="<name>"></h5>` anchor, and `docs/test.ts` needs a `tracer.use` call.
   Add the package to `.github/CODEOWNERS` and the matching CI workflow.
9. Run the plugin tests, structural contract, and changed-file coverage commands from the testing reference.

## Read upstream source first

Use the exact version under test. When the repository and release tag are known, make a shallow clone:

```bash
git clone --depth 1 --branch "<tag>" "<repository-url>" "/tmp/<slug>-versions/<tag>"
```

When the published package is the authoritative artifact, unpack that artifact instead:

```bash
target="/tmp/<slug>-versions/<version>"
mkdir -p "$target"
archive=$(npm pack --silent --pack-destination /tmp "<package>@<version>")
tar -xzf "/tmp/$archive" -C "$target" --strip-components=1
rm "/tmp/$archive"
```

Read the package exports, every distinct CJS and ESM implementation, and the call chain from the public entry point
to the hooked function. Compare the oldest and newest supported versions at each hook path; check argument, return,
error, callback, promise, stream, iterator, and runtime-created-object behavior only where the upstream API exposes
those forms.

## Choose the hook

Use Orchestrion when the operation exists as a matchable source function. It covers CJS and ESM source, sync,
promise, callback, and iterator lifecycles without replacing runtime properties. See
[Orchestrion](references/orchestrion.md).

Use shimmer only when the source cannot express the required boundary:

- the method or handler is created entirely at runtime;
- arguments must change before Orchestrion subscribers run;
- a returned stream, Promise subclass, thenable, or identity-sensitive object must be intercepted in place;
- emitted events, rather than the source function's return, define completion.

Leave one short comment at a shimmer hook naming the constraint that rules out Orchestrion. A decorated public
handle is not enough; match the source function behind it when all calls funnel through one declaration.

See [Shimmer](references/shimmer.md) for the canonical `tracingChannel` and event-driven stream shapes.

## Channel and plugin contract

`TracingPlugin` subscribes to `start`, `end`, `asyncStart`, `asyncEnd`, `error`, and `finish` under its prefix.
Instrumentation determines which events actually fire:

- Orchestrion prefix: `tracing:orchestrion:<package>:<channelName>`
- `tracingChannel('apm:<name>:<operation>')`: `tracing:apm:<name>:<operation>`
- legacy manual channels: omit `static prefix`; the default is `apm:<id>:<operation>`

`bindStart(ctx)` creates the span and returns `ctx.currentStore`. `startSpan(name, options, ctx)` writes both
`ctx.currentStore` and `ctx.parentStore`, and takes `service`, `resource`, `type`, `kind`, `meta`, `metrics`,
`component`, `startTime`, and `childOf`, where `childOf: null` forces a root span. Orchestrion supplies
`ctx.arguments` and `ctx.self`; shimmer instrumentation usually adds named fields. Completion supplies `ctx.result`
or `ctx.error`.

`CachePlugin`, `ProducerPlugin`, and `ConsumerPlugin` override that signature as `startSpan(options, ctx)` and take
the name from `operationName()` instead, so passing a name to them shifts every argument by one. Read the base
class before the first call. `operationName()` and `serviceName()` resolve through
`service-naming/schemas/<version>/<type>.js` and throw for an unregistered id, so a plugin reaching them needs its
schema entries before it can start a span.

Finish on the event that carries actual completion. Orchestrion never emits `finish`; promise and callback hooks
normally complete through `asyncEnd`. `end` fires when the wrapped call returns, so for an async operation it runs
before the result exists: a handler that finishes spans on `end` keeps the presence check
(`if (!Object.hasOwn(ctx, 'result') && !Object.hasOwn(ctx, 'error')) return`) or it closes the span early. Never
drop that guard from an existing plugin.

`TracingPlugin` already tags `ctx.error` on the current span, so override `error` only to add tags or to skip a
non-error the library reports as one. Do not add manual subscriptions when the standard prefix and lifecycle methods
are enough; `InboundPlugin` and `OutboundPlugin` already return `ctx.parentStore` from `bindFinish`.

Use `CompositePlugin` when separate operations need separate prefixes or base classes. It instantiates every entry of
`static plugins` and configures each by key, so `{ <key>: false }` disables one sub-plugin.

## Choose the plugin base

Each class below `TracingPlugin` sets `operation`, `kind`, and `type` defaults that feed service and operation
naming, so the base choice decides span naming as much as behavior. `RouterPlugin` sits outside the span lifecycle:
it descends from `Plugin` through `WebPlugin` and has no `bindStart` / `startSpan` contract.

```text
Plugin
├── LogPlugin
├── CompositePlugin
├── WebPlugin
│   └── RouterPlugin
└── TracingPlugin
    ├── InboundPlugin
    │   ├── ServerPlugin
    │   └── ConsumerPlugin
    └── OutboundPlugin
        ├── ProducerPlugin
        └── ClientPlugin
            ├── HttpClientPlugin
            └── StoragePlugin
                ├── DatabasePlugin
                └── CachePlugin
```

| Library role | Base class (require path) | Current reference |
| --- | --- | --- |
| Database | `DatabasePlugin` (`dd-trace/src/plugins/database`) | `datadog-plugin-pg` |
| Cache | `CachePlugin` (`dd-trace/src/plugins/cache`) | `datadog-plugin-redis` |
| HTTP client | `HttpClientPlugin` (`datadog-plugin-http/src/client`) | `datadog-plugin-fetch` |
| RPC or generic client | `ClientPlugin` (`dd-trace/src/plugins/client`) | `datadog-plugin-grpc` |
| HTTP server | `ServerPlugin` (`dd-trace/src/plugins/server`) | `datadog-plugin-http` |
| Web framework or router | `RouterPlugin` (`datadog-plugin-router/src`) | `datadog-plugin-express` |
| Message producer | `ProducerPlugin` (`dd-trace/src/plugins/producer`) | `datadog-plugin-kafkajs` |
| Message consumer | `ConsumerPlugin` (`dd-trace/src/plugins/consumer`) | `datadog-plugin-kafkajs` |
| Log correlation | `LogPlugin` (`dd-trace/src/plugins/log_plugin`) | `datadog-plugin-pino` |
| Several operations | `CompositePlugin` (`dd-trace/src/plugins/composite`) | `datadog-plugin-langchain` |
| No more specific contract | `TracingPlugin` (`dd-trace/src/plugins/tracing`) | `datadog-plugin-child_process` |

The base class is behavior, not taxonomy. Read its implementation and a current subclass before choosing it.

## Minimal plugin shape

For a synchronous Orchestrion operation, start with this shape in
`packages/datadog-plugin-<name>/src/index.js`:

```js
'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class ExamplePlugin extends TracingPlugin {
  static id = '<name>'
  static operation = '<operation>'
  static prefix = 'tracing:orchestrion:<package>:<channel>'

  bindStart (ctx) {
    this.startSpan('<name>.<operation>', {
      resource: '<low-cardinality-resource>',
      type: '<span-type>',
    }, ctx)
    return ctx.currentStore
  }

  end (ctx) {
    this.finish(ctx)
  }
}

module.exports = ExamplePlugin
```

Replace `TracingPlugin` with the role-specific base when one applies, and check whether that base already supplies
the span name and `startSpan` signature. Use `asyncEnd` instead of `end` when the instrumentation reports promise or
callback completion, and add lifecycle overrides only for behavior the base class does not provide.

## Subscriber cardinality

A publish site may serve tracing, AppSec, IAST, telemetry, or other subscribers. A tracing plugin may need one event
per first occurrence while another subscriber needs one per call and mutates that call's payload by reference.

Before moving a publish behind deduplication, caching, depth filtering, or an early return:

1. Search for the exact channel name.
2. Classify each subscriber's required cardinality and payload identity.
3. Keep per-call publication before the gate when any subscriber needs it.
4. Split per-call and deduplicated events when the contracts differ.

`hasSubscribers` may skip channel work only when no subscriber needs the event. Do not equate "plugin disabled" with
"channel unused."

## Debugging

- Missing spans: compare the exact instrumentation and plugin prefixes, then check which lifecycle event fires.
- Lost parenting: verify the start event uses `runStores()` or an Orchestrion binding and `bindStart` returns the
  store.
- CJS works but ESM fails: inspect the package's separate ESM source, its Orchestrion entry for that file, and
  whether the hook needs `esmFirst`; do not assume one build path covers both.
- Premature spans: verify the selected sync/promise/callback operator and the plugin's completion method.
- Missing AppSec or IAST behavior: inspect all channel subscribers and restore the required per-call publication.
