# Rewriter and Plugin Checklist

Use this reference while editing or reviewing an Orchestrion migration.

## Rewriter Entries

Create entries in:

`packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/<package>.js`

Register them in the rewriter instrumentations index if the package is not
already registered.

Each migrated operation needs a source-verified entry:

```js
{
  module: {
    name: '<npm package>',
    versionRange: '<version range from old addHook unless verified otherwise>',
    filePath: '<path inside the package>'
  },
  functionQuery: {
    kind: 'Sync',
    methodName: '<method>',
    className: '<class>'
  },
  channelName: '<operation_channel>'
}
```

Use `functionName` for top-level declarations and `expressionName` for function
or arrow expressions assigned to a name. Use raw `astQuery` only when
`functionQuery` cannot express a verified target.

## Kind Selection

Choose the kind from the package source, not from the old wrapper:

| Source behavior | Orchestrion kind | Plugin finish path |
| --- | --- | --- |
| synchronous return or throw | `Sync` | `end(ctx)` |
| returns a Promise or is `async` | `Async` | `asyncEnd(ctx)` |
| callback completes operation | `Callback` | `asyncEnd(ctx)` |
| async generator or async iterable lifecycle | `AsyncIterator` | base channel plus `_next` channel |

For callbacks, use `functionQuery.index` when the callback is not always the
last argument. If an `Async` target can return non-Promise values on early
branches, handle both `end(ctx)` and `asyncEnd(ctx)` in the plugin.

## File Paths and Module Formats

Read the installed package source for the supported version range. Check
`package.json` `main`, `module`, `exports`, and any CJS/ESM build directories.
Add separate entries for distinct CJS and ESM files that define the same target.

Do not add an ESM path from naming convention alone. Verify the file exists and
contains the target function/class/method.

## Plugin Subscription Rules

Use the Orchestrion channel prefix:

```js
static prefix = 'tracing:orchestrion:<npm-package>:<channelName>'
```

`<channelName>` must exactly match the rewriter config. Use the old plugin only
as a behavior source. It may read old shimmer-created `ctx` fields that no
longer exist. In Orchestrion plugins, prefer:

- `ctx.arguments` for call arguments;
- `ctx.self` for the receiver instance;
- `ctx.result` for return or resolved values;
- `ctx.error` for thrown or rejected errors;
- `ctx.currentStore` for the span store created by `startSpan`.

Always call `this.startSpan(..., ctx)` so the span is stored in the Orchestrion
context.

## Dependent Channels and Compatibility

Before removing old channel publishes, run `rg` for each old channel name.
Classify subscribers by required cardinality:

- tracing span lifecycle: usually one event per span;
- IAST or AppSec analysis: often one event per library call or argument object;
- DSM or propagation: may require exact position relative to user callbacks.

If a non-tracing subscriber depends on old channels, either preserve a
legacy-compatible publish path or migrate that subscriber and add focused
coverage. For subclassed integrations such as `mysql2` or `mariadb` reusing
`datadog-plugin-mysql`, verify the dependent plugin still receives the data it
expects even if the primary package now uses Orchestrion.

## Cleanup

Before finishing, verify:

- no stale `shimmer.wrap`, `shimmer.unwrap`, `shimmer.massWrap`, or unused
  shimmer imports remain for the migrated operation;
- the instrumentation entrypoint is the `getHooks` bridge unless a documented
  non-Orchestrion hook is still required;
- rewriter config is registered once;
- plugin prefixes match the rewriter `channelName` values;
- tests still assert the old behavior rather than weaker new behavior.
