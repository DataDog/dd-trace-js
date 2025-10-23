'use strict'

const {
  FakeAgent,
  linkedSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox
  let variants

  // test against later versions because server.mjs uses newer package syntax
  withVersions('cassandra-driver', 'cassandra-driver', '>=4.4.0', version => {
    before(async function () {
      this.timeout(60000)
      sandbox = await linkedSandbox([`'cassandra-driver@${version}'`], false, [
        './packages/datadog-plugin-cassandra-driver/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', 'cassandra-driver', 'Client')
    })

    after(async () => {
      await sandbox.remove()
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
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'cassandra.query'), true)
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
