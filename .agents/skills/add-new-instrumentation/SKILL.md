---
name: add-new-instrumentation
description: Guide for adding new instrumentation and plugins to dd-trace. Use when creating a new plugin, adding instrumentation for a third-party library, or when the user asks about adding new instrumentations or plugins.
---

# Adding New Instrumentation

## Architecture Overview

The instrumentation system has two layers that communicate via Node.js diagnostic channels:

1. **Instrumentation** (`packages/datadog-instrumentations/src/<name>.js`) — hooks into third-party library internals using `addHook()` and `shimmer`, then publishes events to named diagnostic channels.
2. **Plugin** (`packages/datadog-plugin-<name>/src/index.js`) — subscribes to those channels to implement APM tracing logic (spans, metadata, errors).

This separation means you almost always need to create **both** files.

## Step 1: Create the Instrumentation File

Create `packages/datadog-instrumentations/src/<name>.js`. The following is a starting-point template — adapt the wrapped method(s), context fields, and channel operations to match the actual library's API. Read 1-2 existing instrumentations for the library type you're adding (e.g. `kafkajs.js` for messaging, `redis.js` for caching) before writing yours.

```javascript
'use strict'

const { channel, addHook } = require('./helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

// Channel naming convention: apm:<name>:<operation>:<event>
// Events: start, finish, error, async-start, async-finish
const startCh = channel('apm:<name>:<operation>:start')
const finishCh = channel('apm:<name>:<operation>:finish')
const errorCh = channel('apm:<name>:<operation>:error')

addHook({ name: '<module-name>', versions: ['>=1.0'] }, (moduleExports) => {
  shimmer.wrap(moduleExports, 'methodToWrap', function (original) {
    return function wrappedMethod (...args) {
      if (!startCh.hasSubscribers) {
        return original.apply(this, args)
      }

      const ctx = { /* relevant context */ }
      return startCh.runStores(ctx, () => {
        try {
          const result = original.apply(this, args)
          finishCh.publish(ctx)
          return result
        } catch (err) {
          ctx.error = err
          errorCh.publish(ctx)
          throw err
        }
      })
    }
  })
  return moduleExports
})
```

**Key patterns:**
- Always guard with `if (!startCh.hasSubscribers)` for performance — skip instrumentation if no plugin is listening
- Use `startCh.runStores(ctx, () => {...})` to propagate async context
- Use `shimmer.wrap()` to patch methods non-destructively
- The `versions` array is a semver range; check existing instrumentations for precedents
- For multiple files in a package: use `file: 'path/within/package.js'` in `addHook`
- For multiple module names mapping to the same hooks: call `addHook` multiple times

## Step 2: Create the Plugin Directory and File

```bash
mkdir -p packages/datadog-plugin-<name>/{src,test}
```

### Choosing the Right Base Class

| Scenario | Base Class | Import Path |
|---|---|---|
| Creating trace spans for a single operation type | `TracingPlugin` | `../../dd-trace/src/plugins/tracing` |
| Wrapping an outbound client call (HTTP, gRPC, DB) | `OutboundPlugin` extends `TracingPlugin` | `../../dd-trace/src/plugins/outbound` |
| Wrapping an inbound server/consumer call | `InboundPlugin` extends `TracingPlugin` | `../../dd-trace/src/plugins/inbound` |
| Key-value cache client (Redis, Memcached) | `CachePlugin` extends `TracingPlugin` | `../../dd-trace/src/plugins/cache` |
| Multiple sub-concerns (producer + consumer, or tracing + code-origin) | `CompositePlugin` | `../../dd-trace/src/plugins/composite` |
| Non-tracing feature only | `Plugin` | `../../dd-trace/src/plugins/plugin` |

### Template: Simple TracingPlugin

```javascript
'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class MyPlugin extends TracingPlugin {
  static id = '<name>'        // must match module name
  static operation = '<operation>'  // e.g., 'query', 'send', 'request'
  static system = '<system>'  // e.g., 'redis', 'kafka' (used for peer.service)

  bindStart (ctx) {
    const { relevantField } = ctx

    this.startSpan({
      resource: relevantField,
      service: this.serviceName(),
      meta: {
        'some.tag': relevantField
      }
    }, ctx)
  }

  bindFinish (ctx) {
    this.finish()
  }

  bindError (ctx) {
    this.finish(ctx.error)
  }
}

module.exports = MyPlugin
```

### Template: CompositePlugin

```javascript
'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')

class MyPlugin extends CompositePlugin {
  static id = '<name>'

  static get plugins () {
    return {
      producer: ProducerPlugin,
      consumer: ConsumerPlugin
    }
  }
}

module.exports = MyPlugin
```

For composite plugins, create separate files in `src/` for each sub-plugin (e.g., `src/producer.js`, `src/consumer.js`).

## Step 3: Register the Plugin

Add an entry to `packages/dd-trace/src/plugins/index.js`:

```javascript
// Inside the plugins object:
get '<module-name>' () { return require('../../../datadog-plugin-<name>/src') },
```

If multiple npm package names map to the same plugin (e.g., `redis` and `@redis/client`), add one getter per name.

## Step 4: Add TypeScript Definitions

In `index.d.ts`, add to the `plugins` namespace:

```typescript
// In the Plugins interface:
'<name>': plugins.<name>;

// Add a plugin interface (in alphabetical order with other plugin interfaces):
interface <name> extends Instrumentation {}
// Or with config options:
interface <name> extends Instrumentation {
  optionName?: string | boolean;
}
```

## Step 5: Update docs/test.ts

Add a type-check call in `docs/test.ts`:

```typescript
tracer.use('<name>');
// Or with options:
tracer.use('<name>', { optionName: 'value' });
```

## Step 6: Document in docs/API.md

Add a section in `docs/API.md` (alphabetically ordered):

```markdown
<h5 id="<name>"><h5>

This plugin automatically patches the [<LibraryName>](<url>) module.

| Option | Default | Description |
|--------|---------|-------------|
| `service` | | Service name override. |
```

## Step 7: Add to CI Workflow

Add a job to `.github/workflows/apm-integrations.yml`:

```yaml
<name>:
  runs-on: ubuntu-latest
  env:
    PLUGINS: <name>
    # SERVICES: <docker-service>  # if external services needed
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

Check `.github/workflows/apm-integrations.yml` for the exact current step format used by other plugins.

## Step 8: Write Tests

### Unit Tests

Create `packages/datadog-plugin-<name>/test/index.spec.js`:

```javascript
'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  describe('<name>', () => {
    withVersions('<name>', '<module-name>', (version) => {
      let myLib

      beforeEach(() => {
        return agent.load('<name>')
      })

      beforeEach(() => {
        myLib = require(`../../../versions/<module-name>@${version}`)
      })

      afterEach(() => {
        return agent.close({ ritmReset: false })
      })

      it('should create a span', (done) => {
        agent.use(traces => {
          const span = traces[0][0]
          expect(span.name).to.equal('<name>.<operation>')
          expect(span.service).to.equal('test-<name>')
        }).then(done, done)

        // trigger the instrumented operation
      })
    })
  })
})
```

**Key test helpers:**
- `withVersions(pluginName, moduleName, cb)` — runs tests across installed versions
- `agent.load(pluginName)` — starts a test agent and loads the plugin
- `agent.close({ ritmReset: false })` — tears down (use `ritmReset: false` to preserve require cache)
- `agent.use(traces => { ... })` — asserts on captured traces
- `withNamingSchema(agent, ...)` — tests naming schema conventions
- `withPeerService(agent, ...)` — tests peer service tag

### ESM Integration Tests

ESM tests verify the plugin works with native ES module imports. They live in `packages/datadog-plugin-<name>/test/integration-test/` and use a `FakeAgent` to assert on captured spans.

Create `packages/datadog-plugin-<name>/test/integration-test/server.mjs` — a minimal ESM script that initialises the tracer and triggers the instrumented operation:

```javascript
import 'dd-trace/init.js'
import myLib from '<module-name>'

// trigger the instrumented operation
await myLib.someOperation()
```

Create `packages/datadog-plugin-<name>/test/integration-test/client.spec.js` — the test that spawns the ESM server and asserts spans arrive:

```javascript
'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  let variants

  withVersions('<name>', '<module-name>', version => {
    useSandbox([`'<module-name>@${version}'`], false, [
      './packages/datadog-plugin-<name>/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    before(async function () {
      variants = varySandbox('server.mjs', '<module-name>', '<namedExport>')
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, '<name>.<operation>'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
```

**Key points for ESM tests:**
- `varySandbox('server.mjs', bindingName, namedExport)` generates three import-style variants (`default`, `star`, `destructure`) from `server.mjs` so the instrumentation is verified under all ESM import patterns.
- `varySandbox.VARIANTS` is `['default', 'star', 'destructure']`.
- Pass `byPassDefault: true` as the fifth argument to `varySandbox` when the module has no default export (named-only packages).
- `useSandbox` installs the package versions into a temp sandbox dir; the second argument controls whether it runs `yarn install` inside the sandbox.
- `spawnPluginIntegrationTestProcAndExpectExit` spawns `node <script>` with `DD_TRACE_AGENT_PORT` set to the `FakeAgent` port.
- Each `it` must have a generous timeout (e.g. `20000`) because sandbox setup and process spawning take time.

## Running Tests

```bash
# Run the unit plugin test
./node_modules/.bin/mocha packages/datadog-plugin-<name>/test/index.spec.js

# Or via the test:plugins script (unit tests only)
PLUGINS="<name>" npm run test:plugins

# Run the ESM integration tests
PLUGINS="<name>" npm run test:integration:plugins
```

## Reference Files

- Instrumentation helpers: `packages/datadog-instrumentations/src/helpers/instrument.js`
- Plugin registration: `packages/dd-trace/src/plugins/index.js`
- Example simple plugin: `packages/datadog-plugin-redis/src/`
- Example composite plugin: `packages/datadog-plugin-kafkajs/src/`
- Example instrumentation: `packages/datadog-instrumentations/src/kafkajs.js`
- Example instrumentation: `packages/datadog-instrumentations/src/redis.js`
