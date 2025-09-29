'use strict'

const {
  FakeAgent,
  createSandbox,
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

  withVersions('limitd-client', 'limitd-client', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'limitd-client@${version}'`], false, [
        './packages/datadog-plugin-limitd-client/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', 'limitd-client')
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
          // not asserting for a limitd-client trace,
          // just asserting that we're not completely breaking when loading limitd-client with esm
          assert.strictEqual(checkSpansForServiceName(payload, 'tcp.connect'), true)
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
