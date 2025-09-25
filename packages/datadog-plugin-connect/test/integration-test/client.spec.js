'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
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
  withVersions('connect', 'connect', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'connect@${version}'`], false, [
        './packages/datadog-plugin-connect/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', null, 'connect')
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

    for (const variant of ['default', 'destructure', 'star']) {
      it(`is instrumented (${variant})`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)

        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'connect.request'), true)
        })
      }).timeout(20000)
    }
  })
})
