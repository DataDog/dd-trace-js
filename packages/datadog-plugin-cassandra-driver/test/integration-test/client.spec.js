'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
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
  withVersions('cassandra-driver', 'cassandra-driver', '>=4.4.0', version => {
    useSandbox([`'cassandra-driver@${version}'`], false, [
      './packages/datadog-plugin-cassandra-driver/test/integration-test/*'])

    before(async function () {
      variants = varySandbox('server.mjs', 'cassandra-driver', 'Client')
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
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'cassandra.query'), true)
        })

        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
