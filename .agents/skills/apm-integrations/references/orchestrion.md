# Orchestrion (AST Rewriter)

Orchestrion is the **required default** for new instrumentations. It automatically wraps methods via JSON configuration with correct CJS/ESM handling built in. Orchestrion handles ESM code far more reliably than shimmer-based wrapping because it operates at the AST level rather than trying to monkey-patch module exports.

## Required Files

Orchestrion integrations need three files:

```
packages/datadog-instrumentations/src/
├── <name>.js                           # Hooks file (registers module hooks)
└── helpers/
    ├── hooks.js                        # Entry pointing to <name>.js
    └── rewriter/
        ├── index.js                    # Main rewriter logic
        └── instrumentations/
            ├── langchain.js            # Reference: LangChain config
            └── <name>.js              # JSON config
```

**Hooks file** (`packages/datadog-instrumentations/src/<name>.js`):

```javascript
'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('<npm-package>')) {
  addHook(hook, exports => exports)
}
```

`getHooks` reads the orchestrion JSON config and generates `addHook` entries so the module hooks are registered for the rewriter to process. Without this file, the rewriter will not be triggered.

**hooks.js entry** (`packages/datadog-instrumentations/src/helpers/hooks.js`):

```javascript
'<name>': () => require('../<name>'),
```

## Config Schema

Each entry in the instrumentations array:

```javascript
{
  module: {
    name: string,            // npm package name (e.g. "bullmq", "@langchain/core")
    versionRange: string,    // semver range (e.g. ">=1.0.0")
    filePath: string,        // path within package (e.g. "dist/cjs/classes/queue.js")
  },

  // Option A: functionQuery (recommended)
  functionQuery: {
    kind: 'Async' | 'Callback' | 'Sync',  // transform type (see below)
    methodName: string,      // class method or property method name
    className?: string,      // scope to a specific class
    functionName?: string,   // target a FunctionDeclaration (alternative to methodName)
    expressionName?: string, // target a FunctionExpression/ArrowFunctionExpression
    index?: number,          // Callback only: argument index of the callback (-1 = last)
  },

  // Option B: astQuery (advanced, for edge cases)
  astQuery?: string,         // raw ESQuery selector string — bypasses functionQuery entirely

  channelName: string,       // used in the diagnostic channel name
}
```

### functionQuery Targeting

| Field | Targets |
|---|---|
| `methodName` + `className` | A method on a specific class |
| `methodName` alone | Any class method or object property method with that name |
| `functionName` | A `FunctionDeclaration` by name |
| `expressionName` | A `FunctionExpression` or `ArrowFunctionExpression` by name |

### astQuery (ESQuery Selectors)

For advanced cases where `functionQuery` fields are insufficient, use `astQuery` with a raw [ESQuery](https://github.com/estools/esquery) selector string. This is parsed via `esquery.parse()` and matched against the AST directly. Internally, `functionQuery` is converted to ESQuery selectors — `astQuery` lets you write them directly.

### Basic Example

```javascript
// instrumentations/<name>.js
module.exports = [
  {
    module: {
      name: '<npm-package>',
      versionRange: '>=1.0.0',
      filePath: 'dist/client.js'
    },
    functionQuery: {
      methodName: 'query',
      className: 'Client',
      kind: 'Async'
    },
    channelName: 'Client_query'
  }
]
```

Multiple methods can be wrapped by adding more entries to the array.

## Channel Name Formation

Orchestrion channels follow this pattern:
```
tracing:orchestrion:{module.name}:{channelName}:{event}
```

Example with `module.name: "@langchain/core"` and `channelName: "RunnableSequence_invoke"`:
- `tracing:orchestrion:@langchain/core:RunnableSequence_invoke:start`
- `tracing:orchestrion:@langchain/core:RunnableSequence_invoke:asyncStart`
- `tracing:orchestrion:@langchain/core:RunnableSequence_invoke:asyncEnd`
- `tracing:orchestrion:@langchain/core:RunnableSequence_invoke:end`
- `tracing:orchestrion:@langchain/core:RunnableSequence_invoke:error`

## Function Kinds and Transforms

Orchestrion supports three transform types, selected by the `kind` field:

| Kind | Transform | Behavior |
|------|-----------|----------|
| `Async` | `tracePromise` | Wraps in async arrow, calls `channel.tracePromise()` — handles promise resolution/rejection |
| `Callback` | `traceCallback` | Intercepts callback at `arguments[index]` (default: last arg, i.e. `-1`), wraps it to publish `asyncStart`/`asyncEnd`/`error` events |
| `Sync` | `traceSync` | Wraps in non-async arrow, calls `channel.traceSync()` — handles synchronous return/throw. **Note:** `Sync` is the default when `kind` is omitted or unrecognized. |

All three transforms dispatch to `traceFunction` (for standalone functions) or `traceInstanceMethod` (for class methods, including inherited ones via constructor patching).

For `Callback` kind, use the `index` field to specify which argument is the callback (defaults to `-1`, meaning the last argument).

## Finding the Right filePath

1. Install the package: `npm install <package>`
2. Search for the method definition:
   ```bash
   grep -r "methodName" node_modules/<package>/
   ```
3. Use the path relative to the package root

**IMPORTANT: Patch both CJS and ESM code paths.** Many libraries duplicate their classes across separate CJS and ESM builds (e.g., `dist/cjs/client.js` and `dist/esm/client.js`). Each file path needs its own entry in the instrumentations array with the same `functionQuery` and `channelName`. If only one is patched, the instrumentation will silently fail for the other module format.

Common locations:
- `dist/cjs/index.js` / `dist/esm/index.js` — separate CJS/ESM builds
- `dist/index.js` — single compiled output
- `lib/client.js` — source files
- `src/index.mjs` — ESM source

## Plugin Subscription for Orchestrion

Set `static prefix` to match the orchestrion channel base. The `TracingPlugin` base class automatically subscribes to all events and routes them to `bindStart`, `bindFinish`, etc.

```javascript
class MyPlugin extends TracingPlugin {
  static id = '<name>'
  static prefix = 'tracing:orchestrion:<npm-package>:Client_query'

  bindStart (ctx) {
    const query = ctx.arguments?.[0]
    const instance = ctx.self

    this.startSpan(this.operationName(), {
      resource: query,
      meta: { component: '<name>' }
    }, ctx)

    return ctx.currentStore
  }
}
```

For integrations wrapping multiple methods, create a separate plugin class per method (each with its own `static prefix`), then combine them in a `CompositePlugin`. See langchain for this pattern.

### The `ctx` Object in Orchestrion

- `ctx.arguments` — the original method arguments (array)
- `ctx.self` — the `this` context of the wrapped method (instance)
- `ctx.result` — return value (on asyncEnd/end)
- `ctx.error` — thrown error (on error)
- `ctx.currentStore` — set by `startSpan` in `bindStart`

## Common Issues

### Wrong filePath
**Symptom**: No channel events published
**Fix**: Verify the method is actually defined in that file (not re-exported from elsewhere)

### Case Mismatch
**Symptom**: Method not found
**Fix**: Match exact class/method name casing

### Multiple Build Outputs
**Symptom**: Works in one context, not another
**Fix**: Check if the package has separate CJS/ESM builds with different file paths; each needs its own entry in the instrumentations array

## Reference Implementations

**Langchain** (canonical, multi-method):
- Config: `packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/langchain.js`
- Hooks file: `packages/datadog-instrumentations/src/langchain.js`
- Plugin: `packages/datadog-plugin-langchain/src/tracing.js`

**BullMQ** (simpler, single-package):
- Config: `packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/bullmq.json`
- Hooks file: `packages/datadog-instrumentations/src/bullmq.js`
