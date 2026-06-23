# ESM Integration Testing

ESM packages require subprocess-based testing because ESM modules can't be unloaded.

## File Structure

```
packages/datadog-plugin-{name}/test/
├── index.spec.js              # CJS tests (if dual module)
└── integration-test/
    ├── client.spec.js         # Test runner (CJS)
    └── server.mjs             # Test code (ESM)
```

## server.mjs Template

```javascript
// Pure ESM — runs in subprocess
import 'dd-trace/init.js'
import { Client } from 'mylib'

const client = new Client({
  host: 'localhost',
  port: 5432
})

await client.connect()
await client.query('SELECT 1')
await client.close()
```

## client.spec.js Template

```javascript
'use strict'

const assert = require('node:assert/strict')
const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  let variants

  withVersions('mylib', 'mylib', version => {
    useSandbox([`'mylib@${version}'`], false, [
      './packages/datadog-plugin-mylib/test/integration-test/*'
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    before(async function () {
      variants = varySandbox('server.mjs', 'mylib', 'Client')
    })

    afterEach(async () => {
      proc?.kill()
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'mylib.query'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
```

## Key Helpers

### useSandbox
Creates isolated npm environment:
```javascript
useSandbox(
  [`'mylib@${version}'`],         // Dependencies (quote the spec!)
  false,                           // isGitRepo
  ['./path/to/test/files/*']       // Files to copy
)
```

### spawnPluginIntegrationTestProcAndExpectExit
Spawns subprocess with dd-trace loaded:
```javascript
// Default: uses --loader=dd-trace/loader-hook.mjs
proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server.mjs', agent.port)

// With extra env vars
proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server.mjs', agent.port, null, {
  MY_API_KEY: 'test-key'
})

// LLM packages use --import instead of --loader
proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server.mjs', agent.port, null, {
  NODE_OPTIONS: '--import dd-trace/initialize.mjs'
})
```

### FakeAgent
Mock agent that captures traces:
```javascript
const agent = await new FakeAgent().start()
agent.assertMessageReceived(({ headers, payload }) => {
  // Assert on received spans
})
await agent.stop()
```

### checkSpansForServiceName
```javascript
assert.strictEqual(checkSpansForServiceName(payload, 'mylib.query'), true)
```

### varySandbox (Import Variants)
Tests different import styles:
```javascript
// varySandbox(filename, bindingName, namedExport, packageName, byPassDefault)
variants = varySandbox('server.mjs', 'mylib', 'Client')
// varySandbox.VARIANTS = ['default', 'star', 'destructure']

// Pass byPassDefault: true (5th arg) when module has no default export
variants = varySandbox('server.mjs', 'mylib', 'Client', 'mylib', true)
```

## Reference Implementations

| Package | Pattern | Notes |
|---------|---------|-------|
| kafkajs | Basic | Standard pattern |
| pg | varySandbox | Tests import variants |
| anthropic | --import override | LLM package |
| openai | Extra deps | Additional sandbox deps |
