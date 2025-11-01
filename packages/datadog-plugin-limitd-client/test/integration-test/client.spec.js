'use strict'

const {
  FakeAgent,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  sandboxCwd,
  useSandbox,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let variants

  withVersions('limitd-client', 'limitd-client', version => {
    useSandbox([`'limitd-client@${version}'`], false, [
      './packages/datadog-plugin-limitd-client/test/integration-test/*'])

    before(async function () {
      variants = varySandbox('server.mjs', 'limitd-client')
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

        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
