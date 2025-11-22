'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  sandboxCwd,
  useSandbox,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
describe('esm', () => {
  let agent
  let proc
  let variants
  // test against later versions because server.mjs uses newer package syntax
  withVersions('connect', 'connect', version => {
    useSandbox([`'connect@${version}'`], false, [
      './packages/datadog-plugin-connect/test/integration-test/*'])

    before(async function () {
      variants = varySandbox('server.mjs', 'connect')
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented loaded with ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)

        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.strictEqual(headers['host'], `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'connect.request'), true)
        })
      }).timeout(20000)
    }
  })
})
