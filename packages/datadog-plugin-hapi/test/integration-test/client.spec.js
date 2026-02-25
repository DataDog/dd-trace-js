'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  varySandbox,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../../integration-tests/helpers')

describe('esm', () => {
  let agent
  let proc
  let variants

  withVersions('hapi', '@hapi/hapi', version => {
    useSandbox([`'@hapi/hapi@${version}'`], false, [
      './packages/datadog-plugin-hapi/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    before(async () => {
      variants = varySandbox('server.mjs', 'Hapi', 'server', '@hapi/hapi')
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)

        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assertObjectContains(headers, { host: `127.0.0.1:${agent.port}` })
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'hapi.request'), true)
        })
      }).timeout(20000)
    }
  })
})
