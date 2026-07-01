# Orchestrion (AST Rewriter)

**Required default for new instrumentations when a source function can be
matched.** Orchestrion rewrites a library at load time (CJS + ESM) and injects
`diagnostics_channel` publishes into the matched function. Prefer it for static
source hooks, ESM support, and avoiding runtime monkey-patching; use shimmer
only when the work exists only as a runtime value.

Engine: `@apm-js-collab/code-transformer` (mirror of
[nodejs/orchestrion-js](https://github.com/nodejs/orchestrion-js)), vendored at
`vendor/dist/@apm-js-collab/code-transformer/`. Installed version is in
`vendor/package-lock.json`.

> **Verify before relying on a field/transform.** The engine is actively
> developed and the config surface changes between releases. This doc tracks
> the vendored version (currently 0.15.0); confirm anything below against the
> installed source — `lib/transformer.js` (`#fromFunctionQuery`, `#getOperator`,
> `#visit`) and `lib/transforms.js`. The vendored bundle is single-file with a
> source map; extract `sourcesContent` to read the originals.

## Decision Rule

Use orchestrion when the function to instrument exists in source: top-level
declaration, class/object method, named expression, or assignment to a named
receiver. Do **not** use shimmer just because users reach it through a decorated
runtime handle; match the source function behind the handle instead.

Inactive-path cost is **not zero** in the vendored 0.15.0 templates. The wrapper
builds `__apm$arguments`, `__apm$ctx`, and `__apm$traced` before the selected
operator checks `hasSubscribers`. The check skips channel work and the wrapped
call's tracing body, not the wrapper's array/object/closure setup. For very hot
idle methods, inspect the generated transform or microbench the path before
claiming a perf win.

Reach for shimmer only when no source node can be matched (for example, a method
constructed entirely at runtime) or the instrumentation must mutate arguments
before the original function is invoked. Leave a code comment naming that reason.

## Required Files

```text
packages/datadog-instrumentations/src/
├── <name>.js                                 # Hooks file — triggers the rewriter
└── helpers/
    ├── hooks.js                              # Add: '<name>': () => require('../<name>')
    └── rewriter/
        ├── transforms.js                     # Custom transforms (addTransform)
        └── instrumentations/
            ├── index.js                      # Add: ...require('./<name>')
            └── <name>.js                     # The config array
```

Hooks file (`src/<name>.js`):

```javascript
'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('<npm-package>')) {
  addHook(hook, exports => exports)
}
```

`getHooks` reads the config and registers `addHook` entries so the rewriter
runs on the matched files. Without this file the rewriter is never triggered.

## Config Schema

```javascript
{
  module: {
    name: string,            // npm package name, e.g. 'bullmq', '@langchain/core'
    versionRange: string,    // semver range, e.g. '>=1.0.0' — fail-fast version guard
    filePath: string,        // path within the package, e.g. 'dist/cjs/queue.js'
  },

  // One of: functionQuery (preferred) or astQuery (escape hatch).
  functionQuery: {
    kind: 'Async' | 'Auto' | 'Callback' | 'Sync',  // operator; default 'Sync'
    className?: string,            // scope to a class (with methodName, or alone for ctor)
    methodName?: string,           // class/object method — LITERAL key only (see note)
    privateMethodName?: string,    // #private method
    functionName?: string,         // FunctionDeclaration by name
    expressionName?: string,       // named FunctionExpression / arrow / assignment
    objectName?: string,           // `obj.prop = fn` — MUST pair with propertyName
    propertyName?: string,         //   ('this' is allowed as objectName)
    callbackIndex?: number,        // Callback only: which arg is the callback (-1 = last)
    index?: number,                // which match to wrap when several match (0 = first, null = all)
    returnKind?: 'Iterator' | 'AsyncIterator',  // also patch the returned iterator
    isExportAlias?: boolean,       // resolve ESM `export { local as exported }` to local
  },

  astQuery?: string,         // raw ESQuery selector; bypasses functionQuery entirely
  transform?: string,        // name of a custom transform (overrides kind)
  channelName: string,       // segment of the channel name (see below)
}
```

**Pick the narrowest source match that names the real owner.**

- `methodName` matches literal class/object keys only. Computed keys
  (`{ [name] () {} }`) and string-literal keys need `astQuery`.
- `functionName` beats shimmer for decorated handles. If `app.decorate('x', fn)`
  exposes work through `app.x` but all paths call `async function foo (…)`, match
  `foo`. Mercurius' `app.graphql` funnels through `fastifyGraphQl`; instrument
  that declaration, not the runtime handle.
- `objectName` + `propertyName` pin assignment receivers:
  `conn.query = async () => {}` or `this._query = async () => {}`. Both fields
  are required together; `objectName: 'this'` targets a `ThisExpression`.
- `expressionName` alone constrains the property/expression name, **not** the
  receiver. If several objects assign `.query`, it can match the wrong one.

```javascript
// matches: conn.query = async (...) => { … }
functionQuery: { objectName: 'conn', propertyName: 'query', kind: 'Async' }
// matches: this._query = async (...) => { … }   (inside a constructor)
functionQuery: { objectName: 'this', propertyName: '_query', kind: 'Async' }
```

**Patch both CJS and ESM.** Most libraries ship separate builds (`dist/cjs/…`
and `dist/esm/…`, or `.js` + `.mjs`). Each needs its own entry with the same
`functionQuery`/`channelName`; patching one silently misses the other format.

## kind → operator

| kind | operator | behaviour |
| --- | --- | --- |
| `Sync` (default) | `traceSync` | sync return/throw; `ctx.result` on success |
| `Async` | `tracePromise` | sync **or** promise return; chains `asyncStart`/`asyncEnd`; side-chains Promise subclasses/thenables so subclass methods survive |
| `Callback` | `traceCallback` | wraps the arg at `callbackIndex`; publishes `asyncStart`/`asyncEnd`/`error` from the callback |
| `Auto` | `traceAuto` | runtime branch: if the `callbackIndex` arg is a function → callback path, else promise path |

`returnKind` is orthogonal to `kind`: it injects iterator-patching into the
chosen wrapper, patching `next`/`throw`/`return` on the returned iterator and
publishing to a second `…:next` channel (`Iterator` → sync, `AsyncIterator` →
promise). Use it with a base `kind` for the call itself — e.g. a method that
returns `Promise<AsyncIterable>` uses `kind: 'Async', returnKind: 'AsyncIterator'`
(see `langgraph.js`). This is a two-plugin pattern; read
[async-iterator-pattern.md](./async-iterator-pattern.md) (note: that doc
predates the `returnKind` field name — the *mechanism* matches, verify field
names against the installed version).

## Channel Name Formation

```text
tracing:orchestrion:{module.name}:{channelName}:{event}
```

Events: `start`, `asyncStart`, `asyncEnd`, `end`, `error` (plus the
`{channelName}:next` channel when `returnKind` is set). Example for
`module.name: '@langchain/core'`, `channelName: 'RunnableSequence_invoke'`:
`tracing:orchestrion:@langchain/core:RunnableSequence_invoke:start`, …

## Plugin Subscription

Set `static prefix` to the channel base; `TracingPlugin` subscribes
`start`/`end`/`asyncStart`/`asyncEnd`/`error`/`finish` and routes them to
`bindStart`/`bindFinish`/`end`/`error`.

```javascript
class MyPlugin extends TracingPlugin {
  static id = '<name>'
  static prefix = 'tracing:orchestrion:<npm-package>:Client_query'

  bindStart (ctx) {
    this.startSpan(this.operationName(), {
      resource: ctx.arguments?.[0],
      meta: { component: '<name>' },
    }, ctx)
    return ctx.currentStore
  }
}
```

`ctx` fields: `ctx.arguments` (same array reference later applied to the wrapped
function), `ctx.self`, `ctx.result`, `ctx.error`, and `ctx.currentStore` (set by
`startSpan`). For multi-method integrations, use one plugin per method combined
in a `CompositePlugin` (see langchain).

Multiple module prefixes are manual today. `TracingPlugin.addTraceSub()` and
`addTraceBind()` read only `this.constructor.prefix`; a `static extraPrefixes`
field does nothing unless the plugin overrides `addTraceSubs()`, calls `super`,
then registers the same events for each extra prefix. Use this for forks or
re-exporting packages that should create the same logical span; see
`datadog-plugin-graphql/src/execute.js`.

```javascript
class MyPlugin extends TracingPlugin {
  static prefix = 'tracing:orchestrion:<npm-package>:Client_query'
  static extraPrefixes = [
    'tracing:orchestrion:<fork-package>:Client_query',
  ]

  addTraceSubs () {
    super.addTraceSubs()

    for (const prefix of this.constructor.extraPrefixes) {
      for (const event of ['start', 'end', 'asyncStart', 'asyncEnd', 'error', 'finish']) {
        const bindName = `bind${event.charAt(0).toUpperCase()}${event.slice(1)}`
        if (this[event]) {
          this.addSub(`${prefix}:${event}`, this[event].bind(this))
        }
        if (this[bindName]) {
          this.addBind(`${prefix}:${event}`, this[bindName].bind(this))
        }
      }
    }
  }
}
```

## Custom Transforms

Register a transform the built-ins don't cover via
`InstrumentationMatcher.addTransform(name, fn)` in
`packages/datadog-instrumentations/src/helpers/rewriter/transforms.js`, then
select it from a config with `transform: '<name>'` (it overrides `kind`).
Signature: `(state, node, parent, ancestry) => void`, mutating the AST in place.

Configs run in order and share the AST. Established pattern (see
`waitForAsyncEnd`): built-in wraps first; a later custom transform matches inside
the generated wrapper (for example the `__apm$ctx` literal) and augments it with
data the built-in ctx does not include. Treat custom transforms as stopgaps:
when upstream adds the capability, switch to the built-in option and delete the
registration.

## Propagating Synchronous Errors From `bindStart`

A `:start` subscriber / `bindStore` transform **cannot** propagate a synchronous
throw to the caller — Node's `diagnostics_channel` wraps `runStores`/`publish`
in `try/catch` and re-surfaces the throw async as an uncaught exception, after
the wrapped fn already ran. The wrapper's *own* `catch { …; throw err }` does
propagate, so to make a `:start` observer abort synchronously (canonical case:
AppSec WAF `abort()`), use the **Proxy-on-arguments** pattern:

```js
bindStart (ctx) {
  const abortController = new AbortController()
  if (startCh.hasSubscribers) {
    startCh.publish({ abortController, args })       // subscribers run sync
    if (abortController.signal.aborted) {
      // ctx.arguments is the SAME array the wrapper spreads into the wrapped fn.
      // Replace the arg the wrapped fn reads FIRST with a throwing Proxy; its
      // first property access trips the trap and the wrapper's catch+rethrow
      // propagates to the caller. :end still fires in finally.
      ctx.arguments[0] = new Proxy({}, {
        get () { throw new AbortError('Aborted') },
        has () { throw new AbortError('Aborted') },
      })
      ctx.ddAborted = true
      return ctx.currentStore
    }
  }
  // … normal setup …
}

error (ctx) { if (ctx.ddAborted) return /* abort is not an error */ }
```

Reference: `packages/datadog-plugin-graphql/src/execute.js`
(`apm:graphql:execute:start`). Caveats: target the arg the wrapped fn actually
dereferences first (not always `[0]`); and it fails if the wrapped fn wraps that
access in its own `try/catch`. If you control the wrapped fn, prefer wrapping it
directly.

## Reference Implementations

- **Langchain** (multi-method, CompositePlugin): config
  `helpers/rewriter/instrumentations/langchain.js`, hooks `src/langchain.js`,
  plugin `packages/datadog-plugin-langchain/src/tracing.js`.
- **LangGraph** (`returnKind: 'AsyncIterator'`):
  `helpers/rewriter/instrumentations/langgraph.js`.
- **graphql** (`functionName` + `Sync`, and why per-field resolve hooks are
  *not* done via orchestrion): `helpers/rewriter/instrumentations/graphql.js`.
- **BullMQ** (single package): config
  `helpers/rewriter/instrumentations/bullmq.js`, hooks `src/bullmq.js`.
- **Custom transform**: `helpers/rewriter/transforms.js` (`waitForAsyncEnd`).
