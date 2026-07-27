'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const {
  FakeAgent,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  sandboxCwd,
  useSandbox,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
describe('esm', () => {
  let agent
  let proc
  // test against later versions because server.mjs uses newer package syntax
  withVersions('connect', 'connect', version => {
    useSandbox([`'connect@${version}'`], false, [
      './packages/datadog-plugin-connect/test/integration-test/*'])

    const variants = varySandbox('server.mjs', {
      bindingName: 'connect',
      packageName: 'connect',
      defaultExport: true,
      namedExports: [],
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented loaded with ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)

        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'connect.request'), true)
        })
      }).timeout(20000)
    }
  })
})
