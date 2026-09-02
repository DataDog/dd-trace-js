# Testing Integrations

## Unit Tests

Create `packages/datadog-plugin-<name>/test/index.spec.js`:

```javascript
'use strict'

const assert = require('node:assert/strict')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { ANY_STRING } = require('../../../integration-tests/helpers')

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

      it('should create a span', async () => {
        // Object-based assertion (preferred) — uses assertObjectContains internally
        const expectedSpanPromise = agent.assertFirstTraceSpan({
          name: '<name>.<operation>',
          service: 'test',
          type: 'sql',
          resource: 'SELECT 1',
          meta: {
            component: '<name>',
            'db.type': '<name>',
          },
        })

        // trigger the instrumented operation
        myLib.someOperation()

        await expectedSpanPromise
      })

      it('should create spans with callback assertion', async () => {

        // Callback-based assertion — for complex multi-span assertions
        const expectedSpanPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          assert.strictEqual(span.name, '<name>.<operation>')
          assert.strictEqual(span.meta.component, '<name>')
        })

        // trigger the instrumented operation
        myLib.someOperation()

        await expectedSpanPromise
      })

      it('should create spans if an error occurs', async () => {
        // Callback-based assertion — for complex multi-span assertions
        const expectedSpanPromise = agent.assertFirstTraceSpan({
          name: '<name>.<operation>',
          service: 'test',
          type: 'sql',
          resource: 'SELECT 1',
          meta: {
            component: '<name>',
            'db.type': '<name>',
            'error.message': '<some error message>',
            'error.type': 'TypeError',
            'error.stack': ANY_STRING
          },
        })

        // trigger the instrumented operation with an error
        myLib.someOperationError()

        await expectedSpanPromise
      })
    })
  })
})
```

### Test Agent API

- `agent.load(pluginNames, config, tracerConfig)` — starts test agent and loads plugin(s)
- `agent.close({ ritmReset })` — tears down agent (use `ritmReset: false` to preserve require cache)
- `agent.assertFirstTraceSpan(expectedObject)` — asserts `traces[0][0]` contains the expected properties via `assertObjectContains`. **Preferred for simple single-span assertions.**
- `agent.assertFirstTraceSpan(callback)` — runs callback with `traces[0][0]` for custom assertions
- `agent.assertSomeTraces(callback)` — runs callback with full `traces` array (array of traces, each an array of spans). Use for multi-span or multi-trace assertions.
- `agent.subscribe(handler)` — register handler called on every trace payload
- `agent.unsubscribe(handler)` — remove a subscribed handler
- `agent.reload(pluginName, config)` — reload a plugin with new config
- `agent.reset()` — clear all handlers

### Other Test Helpers

- `withVersions(pluginName, moduleName, cb)` — runs tests across installed versions
- `withNamingSchema(agent, ...)` — tests naming schema conventions
- `withPeerService(agent, ...)` — tests peer service tag

## ESM Integration Tests

ESM tests verify the plugin works with native ES module imports. They live in `packages/datadog-plugin-<name>/test/integration-test/`.

### server.mjs

Minimal ESM script that initializes the tracer and triggers the instrumented operation:

```javascript
import 'dd-trace/init.js'
import myLib from '<module-name>'

await myLib.someOperation()
```

### client.spec.js

Test that spawns the ESM server and asserts spans arrive:

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

  withVersions('<name>', '<module-name>', version => {
    useSandbox([`'<module-name>@${version}'`], false, [
      './packages/datadog-plugin-<name>/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const variants = varySandbox('server.mjs', {
      bindingName: 'myLib',
      packageName: '<module-name>',
      defaultExport: true,
      namedExports: ['<named-export>'],
      namedExportBinding: 'namespace',
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
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

### Key ESM Test Concepts

- `varySandbox(filename, options)` generates the import variants supported by the package's export shape.
- Set `defaultExport`, `namedExports`, and `namedExportBinding` from the installed package's real exports.
- Iterate over `Object.keys(variants)`; the returned object maps each generated variant to its filename.
- `useSandbox` installs package versions into a temp sandbox directory
- `spawnPluginIntegrationTestProcAndExpectExit` spawns `node <script>` with `DD_TRACE_AGENT_PORT` set to FakeAgent port
- Each `it` needs generous timeout (e.g., `20000`) for sandbox setup and process spawning

## Running Tests

dd-trace uses a non-standard dependency installation for plugin tests. Libraries under test are installed per-version via `npm run services` (which drives `scripts/install_plugin_modules.js` and a bun isolated install per sandbox), not through the normal `node_modules`. The `:ci` script handles this automatically.

```bash
# CI command (preferred) — runs `npm run services` for dependency installation, then tests
PLUGINS="<name>" npm run test:plugins:ci

# Unit tests only (assumes `npm run services` already ran)
PLUGINS="<name>" npm run test:plugins

# With external services (e.g., databases, message brokers)
docker compose up -d rabbitmq
SERVICES="rabbitmq" PLUGINS="amqplib" npm run test:plugins:ci

# Filter within plugin tests
PLUGINS="<name>" SPEC="specific.spec.js" npm run test:plugins:ci
```
