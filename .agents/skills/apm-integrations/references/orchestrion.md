# Orchestrion (AST Rewriter)

**Required default for new instrumentations.** Orchestrion rewrites a library's
source at load time (CJS + ESM) and *inlines* `diagnostics_channel` publishes
into the target function. No runtime monkey-patching, so it handles ESM
reliably where shimmer cannot.

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

## Why transform, not wrap

Every generated wrapper opens with `if (!hasSubscribers(channel)) return
original()` and the publish is compiled *into* the method body — so an inactive
integration costs nothing and an active one has the exact shape of hand-written
instrumentation (no wrapper closure, no property copy, no per-call indirection).

Prefer orchestrion over shimmer for performance. Reach for shimmer only when no
source function can be matched (e.g. a value built at runtime that never exists
in source), and say why in a comment.

## Required Files

```
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

**`methodName` matches literal keys only.** It compiles to
`Property[key.name="X"][key.type=Identifier]` / `ClassBody > [key.name="X"]`, so
a *computed* method (`{ [name](){} }`) or a string-literal key is **not**
matched — use `astQuery` for those.

**Prefer a named source function over a runtime handle.** When a library exposes
its work through a method it *decorates onto a runtime instance* (`app.decorate('x',
fn)`, `obj.x = fn` at call time), the runtime handle is not a static source node —
but the function it points at usually *is*. A top-level `async function foo (…)`
that every code path funnels through is matchable with `functionName: 'foo', kind:
'Async'` directly, with no shimmer. Example: mercurius routes every GraphQL request
(HTTP, batched, persisted, programmatic, JIT) through the named declaration
`async function fastifyGraphQl (source, context, variables, operationName)` in
`index.js`, even though users only ever call the decorated `app.graphql`. Match the
declaration, not the handle.

**`objectName` + `propertyName` pin a function assigned to a property.** For
`obj.method = fn` / `this.method = fn` shapes — common in factory and constructor
code where there is no class or named declaration — pair the two fields to match
`AssignmentExpression[left.object.name="obj"][left.property.name="method"] >
[async]`. `objectName: 'this'` targets a `ThisExpression` receiver. Both are
required together; one without the other throws.

```javascript
// matches: conn.query = async (...) => { … }
functionQuery: { objectName: 'conn', propertyName: 'query', kind: 'Async' }
// matches: this._query = async (...) => { … }   (inside a constructor)
functionQuery: { objectName: 'this', propertyName: '_query', kind: 'Async' }
```

`expressionName` alone matches `AssignmentExpression[left.property.name="…"]`
*without* constraining the receiver — when the same property name is assigned on
several objects it instruments the wrong one. Reach for `objectName` + `propertyName`
when the receiver matters.

**Patch both CJS and ESM.** Most libraries ship separate builds (`dist/cjs/…`
and `dist/esm/…`, or `.js` + `.mjs`). Each needs its own entry with the same
`functionQuery`/`channelName`; patching one silently misses the other format.

## kind → operator

| kind | operator | behaviour |
|------|----------|-----------|
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

```
tracing:orchestrion:{module.name}:{channelName}:{event}
```

Events: `start`, `asyncStart`, `asyncEnd`, `end`, `error` (plus the
`{channelName}:next` channel when `returnKind` is set). Example for
`module.name: '@langchain/core'`, `channelName: 'RunnableSequence_invoke'`:
`tracing:orchestrion:@langchain/core:RunnableSequence_invoke:start`, …

## Plugin Subscription

Set `static prefix` to the channel base; `TracingPlugin` subscribes all events
and routes them to `bindStart`/`bindFinish`/`end`/`error`. Use `extraPrefixes`
when more than one module emits to the same logical span (e.g. a fork that
re-exports under a different package name).

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

`ctx` fields: `ctx.arguments` (the original args array — **same reference**
passed to the wrapped fn), `ctx.self` (`this`), `ctx.result` (on
`asyncEnd`/`end`), `ctx.error` (on `error`), `ctx.currentStore` (set by
`startSpan`). For multi-method integrations, one plugin per method combined in a
`CompositePlugin` (see langchain).

## Custom Transforms

Register a transform the built-ins don't cover via
`InstrumentationMatcher.addTransform(name, fn)` in
`packages/datadog-instrumentations/src/helpers/rewriter/transforms.js`, then
select it from a config with `transform: '<name>'` (it overrides `kind`).
Signature: `(state, node, parent, ancestry) => void`, mutating the AST in place.

Configs run in array order and share the AST, so the established pattern
(precedent: `waitForAsyncEnd`) is **built-in generates, custom post-processes**:
one config wraps with a built-in `kind`; a later config matches a node *inside
the generated wrapper* (e.g. the `__apm$ctx` object literal) via `astQuery` and
augments it — for instance to capture a binding from the enclosing closure that
the built-in `ctx` (only `arguments`/`self`) does not include. Keep custom
transforms as a stopgap: when the capability lands upstream, replace the custom
config with the built-in option and delete the registration.

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
