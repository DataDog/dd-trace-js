'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc

  withVersions('router', 'router', version => {
    useSandbox([`'router@${version}'`]
      , false, ['./packages/datadog-plugin-router/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const variants = varySandbox('server.mjs', {
      bindingName: 'router',
      packageName: 'router',
      defaultExport: true,
      namedExports: [],
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)

        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'router.middleware'), true)
        })
      }).timeout(20000)
    }
  })
})
