# createIntegration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a fluent `createIntegration` builder API that generates Orchestrion configs, plugin classes, and hook entries from a single chained call, then port the sharedb integration to use it.

**Architecture:** A new `packages/datadog-integrations/` package provides the builder. `.build()` produces an integration descriptor with `.orchestrion` (rewriter config array), `.plugin` (plugin class or CompositePlugin), and `.hooks` (hook entries). Existing registries consume these properties.

**Tech Stack:** Node.js, diagnostic channels (dc-polyfill), Orchestrion AST rewriter, mocha/sinon tests.

---

### Task 1: Create the `packages/datadog-integrations/` package skeleton

**Files:**
- Create: `packages/datadog-integrations/src/index.js`
- Create: `packages/datadog-integrations/src/create-integration.js`

**Step 1: Create the package directory**

```bash
mkdir -p packages/datadog-integrations/src
mkdir -p packages/datadog-integrations/test
```

**Step 2: Write the builder module**

Create `packages/datadog-integrations/src/create-integration.js`:

```js
'use strict'

const CachePlugin = require('../../dd-trace/src/plugins/cache')
const ClientPlugin = require('../../dd-trace/src/plugins/client')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const ServerPlugin = require('../../dd-trace/src/plugins/server')
const StoragePlugin = require('../../dd-trace/src/plugins/storage')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const BASE_CLASSES = {
  cache: CachePlugin,
  client: ClientPlugin,
  consumer: ConsumerPlugin,
  database: DatabasePlugin,
  producer: ProducerPlugin,
  server: ServerPlugin,
  storage: StoragePlugin,
  tracing: TracingPlugin,
}

class IntegrationBuilder {
  #id
  #moduleName
  #versionRange
  #filePaths = []
  #pluginType = 'tracing'
  #system
  #methods = []

  constructor (id) {
    this.#id = id
  }

  module (name, versionRange, ...filePaths) {
    this.#moduleName = name
    this.#versionRange = versionRange
    this.#filePaths = filePaths
    return this
  }

  type (pluginType) {
    this.#pluginType = pluginType
    return this
  }

  system (name) {
    this.#system = name
    return this
  }

  method (config) {
    this.#methods.push({ method: config, span: undefined })
    return this
  }

  span (config) {
    const last = this.#methods[this.#methods.length - 1]
    if (!last || last.span) {
      throw new Error('span() must be called after method() and before another method()')
    }
    last.span = config
    return this
  }

  build () {
    const orchestrion = []
    const hooks = []
    const pluginClasses = {}
    const filePaths = this.#filePaths.length > 0
      ? this.#filePaths
      : [undefined]

    for (const { method, span } of this.#methods) {
      const channelName = method.className
        ? `${method.className}_${method.methodName}`
        : method.methodName

      for (const filePath of filePaths) {
        const entry = {
          module: {
            name: this.#moduleName,
            versionRange: this.#versionRange,
          },
          functionQuery: {
            className: method.className,
            methodName: method.methodName,
            kind: method.kind,
          },
          channelName,
        }

        if (filePath) {
          entry.module.filePath = filePath
        }

        if (method.index !== undefined) {
          entry.functionQuery.index = method.index
        }

        orchestrion.push(entry)
      }

      const hookFilePaths = filePaths.filter(Boolean)
      if (hookFilePaths.length > 0) {
        for (const filePath of hookFilePaths) {
          hooks.push({
            name: this.#moduleName,
            versions: [this.#versionRange],
            file: filePath,
          })
        }
      } else {
        hooks.push({
          name: this.#moduleName,
          versions: [this.#versionRange],
        })
      }

      const PluginClass = this.#createPluginClass(channelName, span)
      pluginClasses[channelName] = PluginClass
    }

    // Deduplicate hooks by name+file
    const uniqueHooks = []
    const seenHooks = new Set()
    for (const hook of hooks) {
      const key = `${hook.name}:${hook.file || ''}`
      if (!seenHooks.has(key)) {
        seenHooks.add(key)
        uniqueHooks.push(hook)
      }
    }

    const pluginKeys = Object.keys(pluginClasses)
    let plugin
    if (pluginKeys.length === 1) {
      plugin = pluginClasses[pluginKeys[0]]
    } else {
      plugin = class extends CompositePlugin {
        static id = this.#id
        static plugins = pluginClasses
      }
    }

    return { orchestrion, plugin, hooks: uniqueHooks }
  }

  #createPluginClass (channelName, spanConfig) {
    const id = this.#id
    const moduleName = this.#moduleName
    const system = this.#system
    const prefix = `tracing:orchestrion:${moduleName}:${channelName}`
    const BaseClass = BASE_CLASSES[this.#pluginType]

    if (!BaseClass) {
      throw new Error(`Unknown plugin type: ${this.#pluginType}. Valid types: ${Object.keys(BASE_CLASSES).join(', ')}`)
    }

    const GeneratedPlugin = class extends BaseClass {
      static id = id
      static prefix = prefix

      bindStart (ctx) {
        ctx.config = this.config

        const name = typeof spanConfig.name === 'function'
          ? spanConfig.name(ctx)
          : spanConfig.name

        const resource = typeof spanConfig.resource === 'function'
          ? spanConfig.resource(ctx)
          : spanConfig.resource

        const attributes = typeof spanConfig.attributes === 'function'
          ? spanConfig.attributes(ctx)
          : (spanConfig.attributes || {})

        const options = {
          kind: spanConfig.kind,
          meta: attributes,
        }

        if (resource !== undefined) {
          options.resource = resource
        }

        if (spanConfig.service) {
          options.service = typeof spanConfig.service === 'function'
            ? spanConfig.service.call(this, ctx)
            : spanConfig.service
        }

        if (spanConfig.type) {
          options.type = spanConfig.type
        }

        const span = this.startSpan(name, options, ctx)

        if (spanConfig.onStart) {
          spanConfig.onStart.call(this, ctx, span)
        }

        return ctx.currentStore
      }

      asyncEnd (ctx) {
        const span = ctx.currentStore?.span
        if (!span) return

        if (spanConfig.onFinish) {
          spanConfig.onFinish.call(this, ctx, span)
        }

        span.finish()
      }
    }

    if (system) {
      GeneratedPlugin.system = system
    }

    return GeneratedPlugin
  }
}

function createIntegration (id) {
  return new IntegrationBuilder(id)
}

module.exports = { createIntegration }
```

**Step 3: Create the package entry point**

Create `packages/datadog-integrations/src/index.js`:

```js
'use strict'

module.exports = require('./create-integration')
```

**Step 4: Commit**

```bash
git add packages/datadog-integrations/
git commit -m "feat: add createIntegration builder API in datadog-integrations package"
```

---

### Task 2: Write unit tests for the builder

**Files:**
- Create: `packages/datadog-integrations/test/create-integration.spec.js`

**Step 1: Write tests for the builder API**

Create `packages/datadog-integrations/test/create-integration.spec.js`:

```js
'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
const { createIntegration } = require('../src')

describe('createIntegration', () => {
  describe('builder API', () => {
    it('should return a builder with chainable methods', () => {
      const builder = createIntegration('test-integration')
      assert.strictEqual(typeof builder.module, 'function')
      assert.strictEqual(typeof builder.type, 'function')
      assert.strictEqual(typeof builder.system, 'function')
      assert.strictEqual(typeof builder.method, 'function')
      assert.strictEqual(typeof builder.span, 'function')
      assert.strictEqual(typeof builder.build, 'function')
    })

    it('should support method chaining', () => {
      const builder = createIntegration('test')
        .module('test-pkg', '>=1.0.0', 'lib/index.js')
        .type('server')
        .method({ className: 'Foo', methodName: 'bar', kind: 'Callback', index: 1 })
        .span({ name: 'test.request', kind: 'server', resource: 'test' })
      assert.strictEqual(typeof builder.build, 'function')
    })
  })

  describe('.build()', () => {
    it('should generate orchestrion config entries', () => {
      const { orchestrion } = createIntegration('test')
        .module('test-pkg', '>=1.0.0', 'lib/index.js')
        .type('server')
        .method({ className: 'Foo', methodName: 'bar', kind: 'Callback', index: 1 })
        .span({ name: 'test.request', kind: 'server', resource: 'test' })
        .build()

      assert.strictEqual(orchestrion.length, 1)
      assert.deepStrictEqual(orchestrion[0], {
        module: { name: 'test-pkg', versionRange: '>=1.0.0', filePath: 'lib/index.js' },
        functionQuery: { className: 'Foo', methodName: 'bar', kind: 'Callback', index: 1 },
        channelName: 'Foo_bar',
      })
    })

    it('should generate entries for each filePath', () => {
      const { orchestrion } = createIntegration('test')
        .module('test-pkg', '>=1.0.0', 'dist/cjs/index.js', 'dist/esm/index.js')
        .type('server')
        .method({ className: 'Foo', methodName: 'bar', kind: 'Async' })
        .span({ name: 'test.op', kind: 'client' })
        .build()

      assert.strictEqual(orchestrion.length, 2)
      assert.strictEqual(orchestrion[0].module.filePath, 'dist/cjs/index.js')
      assert.strictEqual(orchestrion[1].module.filePath, 'dist/esm/index.js')
      assert.strictEqual(orchestrion[0].channelName, orchestrion[1].channelName)
    })

    it('should generate hook entries', () => {
      const { hooks } = createIntegration('test')
        .module('test-pkg', '>=1.0.0', 'lib/index.js')
        .type('server')
        .method({ className: 'Foo', methodName: 'bar', kind: 'Callback' })
        .span({ name: 'test.request', kind: 'server' })
        .build()

      assert.strictEqual(hooks.length, 1)
      assert.deepStrictEqual(hooks[0], {
        name: 'test-pkg',
        versions: ['>=1.0.0'],
        file: 'lib/index.js',
      })
    })

    it('should deduplicate hooks across methods', () => {
      const { hooks } = createIntegration('test')
        .module('test-pkg', '>=1.0.0', 'lib/index.js')
        .type('server')
        .method({ className: 'Foo', methodName: 'bar', kind: 'Callback' })
        .span({ name: 'test.a', kind: 'server' })
        .method({ className: 'Foo', methodName: 'baz', kind: 'Async' })
        .span({ name: 'test.b', kind: 'server' })
        .build()

      assert.strictEqual(hooks.length, 1)
    })

    it('should generate a plugin class extending the correct base', () => {
      const ServerPlugin = require('../../dd-trace/src/plugins/server')

      const { plugin } = createIntegration('test')
        .module('test-pkg', '>=1.0.0', 'lib/index.js')
        .type('server')
        .method({ className: 'Foo', methodName: 'bar', kind: 'Callback' })
        .span({ name: 'test.request', kind: 'server' })
        .build()

      assert.strictEqual(plugin.id, 'test')
      assert.ok(plugin.prototype instanceof ServerPlugin)
    })

    it('should generate a plugin with correct static prefix', () => {
      const { plugin } = createIntegration('test')
        .module('test-pkg', '>=1.0.0', 'lib/index.js')
        .type('server')
        .method({ className: 'Foo', methodName: 'bar', kind: 'Callback' })
        .span({ name: 'test.request', kind: 'server' })
        .build()

      assert.strictEqual(plugin.prefix, 'tracing:orchestrion:test-pkg:Foo_bar')
    })

    it('should throw for unknown plugin type', () => {
      assert.throws(() => {
        createIntegration('test')
          .module('test-pkg', '>=1.0.0')
          .type('unknown')
          .method({ className: 'X', methodName: 'y', kind: 'Sync' })
          .span({ name: 't', kind: 'client' })
          .build()
      }, /Unknown plugin type/)
    })

    it('should throw when span() is called without a preceding method()', () => {
      assert.throws(() => {
        createIntegration('test')
          .module('test-pkg', '>=1.0.0')
          .span({ name: 'test', kind: 'client' })
      }, /span\(\) must be called after method\(\)/)
    })

    it('should support function-based resource and attributes in span config', () => {
      const DatabasePlugin = require('../../dd-trace/src/plugins/database')

      const { plugin } = createIntegration('test-db')
        .module('test-db-pkg', '>=2.0.0')
        .type('database')
        .system('testdb')
        .method({ className: 'Client', methodName: 'query', kind: 'Async' })
        .span({
          name: 'testdb.query',
          kind: 'client',
          type: 'sql',
          resource: (ctx) => ctx.arguments?.[0],
          attributes: (ctx) => ({ 'db.type': 'testdb' }),
        })
        .build()

      assert.ok(plugin.prototype instanceof DatabasePlugin)
      assert.strictEqual(plugin.system, 'testdb')
    })

    it('should produce a CompositePlugin for multi-method integrations', () => {
      const CompositePlugin = require('../../dd-trace/src/plugins/composite')

      const { plugin, orchestrion } = createIntegration('multi')
        .module('multi-pkg', '>=1.0.0', 'lib/main.js')
        .type('server')
        .method({ className: 'A', methodName: 'foo', kind: 'Async' })
        .span({ name: 'multi.foo', kind: 'server' })
        .method({ className: 'B', methodName: 'bar', kind: 'Callback', index: -1 })
        .span({ name: 'multi.bar', kind: 'server' })
        .build()

      assert.strictEqual(orchestrion.length, 2)
      assert.ok(plugin.prototype instanceof CompositePlugin)
    })
  })
})
```

**Step 2: Run tests to verify they pass**

```bash
./node_modules/.bin/mocha packages/datadog-integrations/test/create-integration.spec.js
```

Expected: All tests pass.

**Step 3: Commit**

```bash
git add packages/datadog-integrations/test/
git commit -m "test: add unit tests for createIntegration builder"
```

---

### Task 3: Port sharedb to createIntegration

**Files:**
- Create: `packages/datadog-integrations/src/integrations/sharedb.js`
- Modify: `packages/dd-trace/src/plugins/index.js:109` (change registry entry)
- Modify: `packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js` (add sharedb orchestrion config)
- Modify: `packages/datadog-instrumentations/src/sharedb.js` (switch to getHooks pattern)
- Modify: `packages/datadog-instrumentations/src/helpers/hooks.js:138` (keep entry, still needed)

**Step 1: Create the sharedb integration file**

Create `packages/datadog-integrations/src/integrations/sharedb.js`:

```js
'use strict'

const { createIntegration } = require('..')

const READABLE_ACTION_NAMES = {
  hs: 'handshake',
  qf: 'query-fetch',
  qs: 'query-subscribe',
  qu: 'query-unsubscribe',
  bf: 'bulk-fetch',
  bs: 'bulk-subscribe',
  bu: 'bulk-unsubscribe',
  f: 'fetch',
  s: 'subscribe',
  u: 'unsubscribe',
  op: 'op',
  nf: 'snapshot-fetch',
  nt: 'snapshot-fetch-by-ts',
  p: 'presence-broadcast',
  pr: 'presence-request',
  ps: 'presence-subscribe',
  pu: 'presence-unsubscribe',
}

function getActionName (request) {
  const action = request?.a
  return READABLE_ACTION_NAMES[action] || action
}

function getReadableResourceName (actionName, collection, query) {
  let resource = actionName || ''
  if (collection) {
    resource += ' ' + collection
  }
  if (query) {
    resource += ' ' + JSON.stringify(sanitize(query))
  }
  return resource
}

function sanitize (input) {
  if (!isObject(input) || Buffer.isBuffer(input)) return '?'

  const output = {}
  for (const key in input) {
    if (typeof input[key] === 'function') continue
    output[key] = sanitize(input[key])
  }
  return output
}

function isObject (val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
}

module.exports = createIntegration('sharedb')
  .module('sharedb', '>=1', 'lib/agent.js')
  .type('server')
  .method({
    className: 'Agent',
    methodName: '_handleMessage',
    kind: 'Callback',
    index: 1,
  })
  .span({
    name: 'sharedb.request',
    kind: 'server',
    resource (ctx) {
      const request = ctx.arguments[0]
      const actionName = getActionName(request)
      return getReadableResourceName(actionName, request?.c, request?.q)
    },
    attributes (ctx) {
      const request = ctx.arguments[0]
      return {
        'sharedb.action': getActionName(request),
      }
    },
    onStart (ctx, span) {
      if (ctx.config.hooks?.receive) {
        ctx.config.hooks.receive(span, ctx.arguments[0])
      }
    },
    onFinish (ctx, span) {
      if (ctx.config.hooks?.reply) {
        ctx.config.hooks.reply(span, ctx.arguments[0], ctx.result)
      }
    },
  })
  .build()
```

**Step 2: Update the rewriter instrumentations index to include sharedb orchestrion config**

Modify `packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js`:

```js
'use strict'

module.exports = [
  ...require('./ai'),
  ...require('./bullmq'),
  ...require('./langchain'),
  ...require('../../../../../datadog-integrations/src/integrations/sharedb').orchestrion,
]
```

**Step 3: Convert the sharedb instrumentation to Orchestrion getHooks pattern**

Replace `packages/datadog-instrumentations/src/sharedb.js` with:

```js
'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('sharedb')) {
  addHook(hook, exports => exports)
}
```

**Step 4: Update the plugin registry**

In `packages/dd-trace/src/plugins/index.js`, change line 109 from:
```js
  get sharedb () { return require('../../../datadog-plugin-sharedb/src') },
```
to:
```js
  get sharedb () { return require('../../../datadog-integrations/src/integrations/sharedb').plugin },
```

**Step 5: Commit**

```bash
git add packages/datadog-integrations/src/integrations/sharedb.js
git add packages/datadog-instrumentations/src/sharedb.js
git add packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/index.js
git add packages/dd-trace/src/plugins/index.js
git commit -m "feat: port sharedb integration to createIntegration builder"
```

---

### Task 4: Run existing sharedb tests and fix any issues

**Step 1: Run the sharedb plugin tests**

```bash
PLUGINS=sharedb npm run test:plugins
```

Expected: Tests should pass. The Orchestrion rewriter will transform sharedb's `Agent.prototype._handleMessage` at load time, and the generated plugin class will subscribe to the resulting diagnostic channel.

**Step 2: If tests fail, debug and fix**

Common issues to watch for:
- **ctx shape differences**: The old shimmer ctx had `{ actionName, request }`. The new Orchestrion ctx has `{ arguments: [request, callback], self: agentInstance }`. The span config functions must use `ctx.arguments[0]` instead of `ctx.request`.
- **asyncEnd vs bindFinish**: The old plugin used `bindFinish` (from InboundPlugin). The new generated plugin uses `asyncEnd`. Verify that the callback result `ctx.result` is available (Orchestrion Callback kind sets `ctx.result = res` from `callback(err, res)`).
- **Service name**: The old plugin passed `service: this.config.service` explicitly. The ServerPlugin base class may handle this differently. Check that `service` tag matches test expectations.
- **Hook configuration**: The old plugin checked `this.config.hooks.receive` and `this.config.hooks.reply`. The generated plugin passes `this.config` via `ctx.config`. Verify hook callbacks fire with correct arguments.

**Step 3: Fix any issues found and re-run tests**

**Step 4: Commit fixes if any**

```bash
git add -A
git commit -m "fix: resolve sharedb test failures in createIntegration port"
```

---

### Task 5: Add integration test for the createIntegration + sharedb combo

**Files:**
- Create: `packages/datadog-integrations/test/integrations/sharedb.spec.js`

**Step 1: Write an integration-level test**

Create `packages/datadog-integrations/test/integrations/sharedb.spec.js`:

```js
'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

describe('sharedb createIntegration descriptor', () => {
  const sharedb = require('../../src/integrations/sharedb')

  it('should export orchestrion, plugin, and hooks', () => {
    assert.ok(Array.isArray(sharedb.orchestrion))
    assert.ok(typeof sharedb.plugin === 'function')
    assert.ok(Array.isArray(sharedb.hooks))
  })

  it('should have correct orchestrion config', () => {
    assert.strictEqual(sharedb.orchestrion.length, 1)
    assert.deepStrictEqual(sharedb.orchestrion[0].module, {
      name: 'sharedb',
      versionRange: '>=1',
      filePath: 'lib/agent.js',
    })
    assert.deepStrictEqual(sharedb.orchestrion[0].functionQuery, {
      className: 'Agent',
      methodName: '_handleMessage',
      kind: 'Callback',
      index: 1,
    })
    assert.strictEqual(sharedb.orchestrion[0].channelName, 'Agent__handleMessage')
  })

  it('should have correct hooks config', () => {
    assert.deepStrictEqual(sharedb.hooks, [{
      name: 'sharedb',
      versions: ['>=1'],
      file: 'lib/agent.js',
    }])
  })

  it('should have a plugin class with correct id and prefix', () => {
    assert.strictEqual(sharedb.plugin.id, 'sharedb')
    assert.strictEqual(sharedb.plugin.prefix, 'tracing:orchestrion:sharedb:Agent__handleMessage')
  })
})
```

**Step 2: Run the test**

```bash
./node_modules/.bin/mocha packages/datadog-integrations/test/integrations/sharedb.spec.js
```

Expected: All pass.

**Step 3: Commit**

```bash
git add packages/datadog-integrations/test/
git commit -m "test: add integration tests for sharedb createIntegration descriptor"
```

---

### Task 6: Verify full sharedb plugin test suite passes end-to-end

**Step 1: Run full plugin tests with services**

```bash
PLUGINS=sharedb npm run test:plugins
```

**Step 2: Verify all 7 test cases pass**

Expected results:
- "should do automatic instrumentation" — PASS
- "should be compatible with existing middleware" — PASS
- "should sanitize queries" — PASS
- "should gracefully handle an invalid or unsupported message action" — PASS
- "should gracefully handle a message without data" — PASS
- "should propagate the parent tracing context" — PASS
- "should support receive and reply hooks" — PASS
- "should do automatic instrumentation & handle errors" — PASS

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: createIntegration builder with sharedb port - complete"
```
