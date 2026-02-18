# New Integration Guide

Step-by-step checklist for creating a new dd-trace-js integration from scratch.

## Prerequisites

- Read 1-2 reference integrations of the same library type (see SKILL.md reference table)
- Determine the instrumentation approach: orchestrion (default) or shimmer (only if orchestrion cannot work — document why)
- Identify the correct plugin base class for the library type

## Step 1: Create the Instrumentation

### Orchestrion (Default)

Orchestrion requires three files:

**1. JSON config** — `packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/<name>.js`:

```javascript
module.exports = [{
  module: {
    name: '<npm-package>',
    versionRange: '>=1.0.0',
    filePath: 'dist/client.js'  // file containing the target method
  },
  functionQuery: {
    methodName: 'query',
    className: 'Client',
    kind: 'Async'  // Async | Callback | Sync
  },
  channelName: 'Client_query'
}]
```

To find `filePath`, inspect the installed package to locate where the target method is defined. **Many libraries duplicate classes across separate CJS and ESM builds** (e.g., `dist/cjs/client.js` and `dist/esm/client.js`). Add a separate entry for each file path with the same `functionQuery` and `channelName` — otherwise the uninstrumented module format will silently fail.

**2. Hooks file** — `packages/datadog-instrumentations/src/<name>.js`:

```javascript
'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('<npm-package>')) {
  addHook(hook, exports => exports)
}
```

`getHooks` reads the orchestrion config and generates `addHook` entries automatically. This file is needed so the module hooks are registered for the rewriter to process.

**3. hooks.js entry** — (see Register in hooks.js below)

See `orchestrion.md` for the full config schema, ESQuery support, and channel naming.

### Shimmer (Only When Orchestrion Cannot Work)

Create `packages/datadog-instrumentations/src/<name>.js`. Always add a comment explaining why orchestrion is not viable!!!

**When using shimmer, prefer `tracingChannel` over manual channels.** `tracingChannel` (from `dc-polyfill` or `diagnostics_channel`) automatically provides `start`, `end`, `asyncStart`, `asyncEnd`, and `error` events — less boilerplate and consistent with how orchestrion works internally.

**Streaming example** (the main case where shimmer is needed — intercepting emitted events on returned stream objects):

```javascript
'use strict'

// Shimmer required: <library> returns a stream object whose events must be
// intercepted — orchestrion wraps method return values, not emitted events.

const { addHook } = require('./helpers/instrument')
const { tracingChannel } = require('dc-polyfill')
const shimmer = require('../../../datadog-shimmer')

// tracingChannel is preferred over manual channels — provides start/end/asyncStart/asyncEnd/error automatically
const ch = tracingChannel('apm:<name>:<operation>')

addHook({ name: '<module-name>', versions: ['>=1.0'] }, (moduleExports) => {
  shimmer.wrap(moduleExports.prototype, 'query', function (original) {
    return function wrappedQuery (...args) {
      if (!ch.start.hasSubscribers) {
        return original.apply(this, args)
      }

      const ctx = { query: args[0], client: this }

      return ch.start.runStores(ctx, () => {
        try {
          const stream = original.apply(this, args)

          // Wrap emit to intercept stream lifecycle events
          shimmer.wrap(stream, 'emit', function (emit) {
            return function (event, arg) {
              switch (event) {
                case 'error':
                  ctx.error = arg
                  ch.error.publish(ctx)
                  break
                case 'end':
                  ch.asyncEnd.publish(ctx)
                  break
              }
              return emit.apply(this, arguments)
            }
          })

          return stream
        } finally {
          ch.end.publish(ctx)
        }
      })
    }
  })
  return moduleExports
})
```

For other shimmer patterns, refer to existing shimmer-based instrumentations in the codebase (e.g., `packages/datadog-instrumentations/src/pg.js`). For `tracingChannel` usage, see `packages/datadog-instrumentations/src/undici.js` or `packages/datadog-instrumentations/src/aerospike.js`.

### Register in hooks.js

Both orchestrion and shimmer paths require an entry in `packages/datadog-instrumentations/src/helpers/hooks.js`:

```javascript
module.exports = {
  // Orchestrion or CJS-only shimmer:
  '<name>': () => require('../<name>'),

  // Shimmer with ESM/dual packages (orchestrion handles ESM automatically):
  '<name>': { esmFirst: true, fn: () => require('../<name>') },
}
```

## Step 2: Create the Plugin

```bash
mkdir -p packages/datadog-plugin-<name>/{src,test}
```

### Choosing the Right Base Class

| If the library... | Use | Import | Key Features |
|---|---|---|---|
| Queries a database | `DatabasePlugin` | `../../dd-trace/src/plugins/database` | DBM comment injection, `db.*` tags |
| Caches data (Redis, Memcached) | `CachePlugin` | `../../dd-trace/src/plugins/cache` | Cache-specific tags |
| Makes HTTP/RPC requests | `ClientPlugin` | `../../dd-trace/src/plugins/client` | Peer service, distributed tracing headers |
| Handles HTTP requests | `ServerPlugin` | `../../dd-trace/src/plugins/server` | Request/response lifecycle |
| Routes requests (middleware) | `RouterPlugin` | `../../dd-trace/src/plugins/router` | Middleware span tracking, route extraction |
| Produces messages | `ProducerPlugin` | `../../dd-trace/src/plugins/producer` | DSM integration, messaging tags |
| Consumes messages | `ConsumerPlugin` | `../../dd-trace/src/plugins/consumer` | DSM integration, messaging tags |
| Has multiple operations | `CompositePlugin` | `../../dd-trace/src/plugins/composite` | Combines sub-plugins |
| Injects trace context into logs | `LogPlugin` | `../../dd-trace/src/plugins/log` | No spans, log correlation |
| None of the above | `TracingPlugin` | `../../dd-trace/src/plugins/tracing` | Generic span creation |

**Wrong base class = complex workarounds.** If fighting the base class, the choice is probably wrong.

### Create the Plugin File

Create `packages/datadog-plugin-<name>/src/index.js` (adapt base class and tags to library type):

```javascript
'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class MyPlugin extends DatabasePlugin {
  static id = '<name>'
  static operation = '<operation>'
  // Channel prefix determines how the plugin subscribes to instrumentation events.
  // Three patterns exist — set `static prefix` explicitly based on instrumentation type:
  //
  // Orchestrion:              static prefix = 'tracing:orchestrion:<npm-package>:<channelName>'
  // Shimmer + tracingChannel: static prefix = 'tracing:apm:<name>:<operation>'
  // Shimmer + manual channels: omit prefix — defaults to `apm:${id}:${operation}`
  static peerServicePrecursors = ['db.name']

  bindStart (ctx) {
    // Orchestrion: use ctx.arguments and ctx.self
    // Shimmer: use named properties like ctx.sql, ctx.client
    const { sql, client } = ctx

    this.startSpan(this.operationName(), {
      service: this.serviceName({ pluginConfig: this.config }),
      resource: sql,
      type: 'sql',
      meta: {
        component: '<name>',
        'db.type': '<name>'
      }
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = MyPlugin
```

For `CompositePlugin` (multiple operations like produce + consume), create separate sub-plugin files in `src/`. See `plugin-patterns.md` for the composite pattern and detailed base class examples.

## Step 3: Register the Plugin

Add to `packages/dd-trace/src/plugins/index.js`:

```javascript
get '<module-name>' () { return require('../../../datadog-plugin-<name>/src') },
```

If multiple npm packages map to the same plugin (e.g., `redis` and `@redis/client`), add one getter per name.

## Step 4: Add TypeScript Definitions

In `index.d.ts`, add to the `plugins` namespace:

```typescript
// In the Plugins interface:
'<name>': plugins.<name>;

// Add plugin interface (alphabetical order):
interface <name> extends Instrumentation {}
// With config options:
interface <name> extends Instrumentation {
  optionName?: string | boolean;
}
```

## Step 5: Update docs/test.ts

Add type-check call:

```typescript
tracer.use('<name>');
tracer.use('<name>', { optionName: 'value' });
```

## Step 6: Document in docs/API.md

Add section alphabetically:

```markdown
<h5 id="<name>"><h5>

This plugin automatically patches the [<LibraryName>](<url>) module.

| Option | Default | Description |
|--------|---------|-------------|
| `service` | | Service name override. |
```

## Step 7: Add CI Job

Add to `.github/workflows/apm-integrations.yml`:

```yaml
<name>:
  runs-on: ubuntu-latest
  env:
    PLUGINS: <name>
    # SERVICES: <docker-service>  # if external services needed, plus the service configuration. should match docker-compose
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/testagent/start
    - uses: ./.github/actions/node
      with:
        version: ${{ matrix.node-version }}
    - uses: ./.github/actions/install
    - run: yarn test:plugins:ci
  strategy:
    matrix:
      node-version: [18, 22]
```

Check the existing workflow for the current step format.

## Step 8: Write Tests

See `testing.md` for complete templates.

**Unit tests** — `packages/datadog-plugin-<name>/test/index.spec.js`
**ESM integration tests** — `packages/datadog-plugin-<name>/test/integration-test/`

```bash
# CI command (preferred) — handles dependency installation via yarn services
PLUGINS="<name>" npm run test:plugins:ci
```

## Checklist

- [ ] Instrumentation created (orchestrion JSON config + hooks file, or shimmer with justification comment)
- [ ] Registered in hooks.js (required for both orchestrion and shimmer paths)
- [ ] Plugin created with correct base class
- [ ] Plugin registered in `packages/dd-trace/src/plugins/index.js`
- [ ] TypeScript definitions added to `index.d.ts`
- [ ] Type check added to `docs/test.ts`
- [ ] Documentation added to `docs/API.md`
- [ ] CI job added to `.github/workflows/apm-integrations.yml`
- [ ] Unit tests written and passing
- [ ] ESM integration tests written and passing
