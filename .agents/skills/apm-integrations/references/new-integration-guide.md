# New integration guide

Use this guide after the parent skill's [execution sequence](../SKILL.md#execution-sequence). It provides the
file-by-file scaffold; the parent skill and linked references own the behavioral contracts.

## 1. Record the upstream contract

Before editing dd-trace-js, record:

- the oldest and newest supported package versions;
- every distinct CJS and ESM implementation file;
- the public call and the source function that owns the work;
- each supported completion form: sync, promise, callback, iterator, stream, or emitted event;
- the arguments and instance fields needed for span tags;
- any other subscriber of the diagnostic channel.

Read the exact published source with the parent's
[source-retrieval procedure](../SKILL.md#read-upstream-source-first). The implementation and tests below follow
that ledger.

## 2. Add instrumentation

### Orchestrion

When the source function is statically matchable, add
`packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/<name>.js`:

```js
'use strict'

module.exports = [
  {
    module: {
      name: '<package>',
      versionRange: '>=1.0.0',
      filePath: 'dist/cjs/client.js',
    },
    functionQuery: {
      className: 'Client',
      methodName: 'query',
      kind: 'Async',
    },
    channelName: 'Client_query',
  },
  {
    module: {
      name: '<package>',
      versionRange: '>=1.0.0',
      filePath: 'dist/esm/client.js',
    },
    functionQuery: {
      className: 'Client',
      methodName: 'query',
      kind: 'Async',
    },
    channelName: 'Client_query',
  },
]
```

Use only entries for builds the package actually ships. Copy the target and operator rules from
[Orchestrion](orchestrion.md), then register the config in
`packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js`.

Add `packages/datadog-instrumentations/src/<name>.js`:

```js
'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('<package>')) {
  addHook(hook, exports => exports)
}
```

### Shimmer

Use shimmer only for a constraint listed in the parent
[hook decision](../SKILL.md#choose-the-hook). Put the concrete constraint in the wrapper comment and follow
[Shimmer](shimmer.md). For a promise-returning method, the minimal shape is:

```js
'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, tracingChannel } = require('./helpers/instrument')

const channel = tracingChannel('apm:<name>:<operation>')

function wrapOperation (operation) {
  return function (...args) {
    const ctx = { client: this, input: args[0] }
    return channel.tracePromise(operation, ctx, this, ...args)
  }
}

addHook({ name: '<package>', versions: ['>=1.0.0'] }, exports => {
  // Shimmer is required because <runtime-owned constraint>.
  shimmer.wrap(exports.Client.prototype, 'query', wrapOperation)
  return exports
})
```

Do not use this promise shape for event-driven or identity-sensitive results. Use the event boundary from the
shimmer reference instead.

### Register the hook factory

Add one key per npm package name to
`packages/datadog-instrumentations/src/helpers/hooks.js`:

```js
'<package>': () => require('../<name>'),
```

Use `{ esmFirst: true, fn: () => require('../<name>') }` only when the hook factory must run before an ESM package
or one of its subpaths loads. Use `serverless: false` only when loading the hook in a serverless runtime is itself
unsupported.

## 3. Add the plugin

Create `packages/datadog-plugin-<name>/src/index.js`. Start from the closest entry in
[reference plugins](reference-plugins.md), then keep only the fields and lifecycle methods the integration needs.
For an asynchronous Orchestrion operation using `TracingPlugin`:

```js
'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class ExamplePlugin extends TracingPlugin {
  static id = '<name>'
  static operation = '<operation>'
  static prefix = 'tracing:orchestrion:<package>:Client_query'

  bindStart (ctx) {
    this.startSpan('<name>.<operation>', {
      resource: ctx.arguments?.[0],
      type: '<span-type>',
    }, ctx)
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }
}

module.exports = ExamplePlugin
```

Replace the base when a role-specific contract applies. `CachePlugin`, `ProducerPlugin`, and `ConsumerPlugin`
take `startSpan(options, ctx)`; the other tracing bases take `startSpan(name, options, ctx)`. See
[plugin patterns](plugin-patterns.md) before calling the method.

If `operationName()` or `serviceName()` is used, register the plugin id under its `type` and `kind` in both
`packages/dd-trace/src/service-naming/schemas/v0/<type>.js` and `v1/<type>.js` before running the plugin.

## 4. Register the public integration

Update every applicable surface:

1. Add the runtime getter to `packages/dd-trace/src/plugins/index.js`; add one getter per npm package name.
2. Add the plugin configuration to `index.d.ts` and `index.d.v5.ts`, unless the integration is v6-only.
3. Add `tracer.use('<name>')` and configured variants to `docs/test.ts`.
4. Add the `<h5 id="<name>"></h5>` anchor and `Available Plugins` entry to `docs/API.md`.
5. Add the package path to `.github/CODEOWNERS`.
6. Add a matching job to the workflow that owns this integration.

Do not copy a workflow skeleton from this guide. Copy the closest current job so its Node matrix, services,
coverage flags, and shared actions match the repository at implementation time.

## 5. Add versions and tests

Add the latest tested package version to `packages/dd-trace/test/plugins/versions/package.json`. The supported
range remains owned by the instrumentation declaration. Run `yarn services` to materialize the generated
`versions/` entries.

Create `packages/datadog-plugin-<name>/test/index.spec.js` and drive the installed package through its public API:

```js
'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  describe('<name>', () => {
    withVersions('<name>', '<package>', version => {
      let library

      beforeEach(async () => {
        await agent.load('<name>')
        library = require(`../../../versions/<package>@${version}`).get()
      })

      afterEach(() => agent.close())

      it('creates a span', async () => {
        const trace = agent.assertFirstTraceSpan({
          name: '<name>.<operation>',
          resource: '<expected-resource>',
          meta: {
            component: '<name>',
          },
        })

        await Promise.all([
          trace,
          library.someOperation(),
        ])
      })
    })
  })
})
```

Adapt setup to the real API. Do not retain a promise in `Promise.all` when the operation is synchronous. Cover the
reachable lifecycle and sibling cases from [Testing integrations](testing.md), including the real CJS and ESM entry
points when their source differs.

## 6. Verify

Run the commands from [Testing integrations](testing.md), including the structural plugin test, focused plugin
tests, ESM sandbox tests when applicable, scoped lint, and changed-file coverage. Confirm that the CI workflow
actually selects every new spec and that no OpenTelemetry exporter environment variable bypasses the mock agent.

## Completion checklist

- [ ] Exact upstream versions, builds, call path, and completion forms recorded.
- [ ] Orchestrion config or justified shimmer wrapper added.
- [ ] Hook factory and every npm package name registered.
- [ ] Plugin uses the correct base, channel prefix, and completion event.
- [ ] Naming schemas contain every id reached by `operationName()` or `serviceName()`.
- [ ] Runtime getter, both applicable type files, docs, CODEOWNERS, and CI updated.
- [ ] Version manifest and real-path tests cover success, error, siblings, and module formats.
- [ ] Focused tests, structural test, lint, and changed-line/branch coverage pass.
