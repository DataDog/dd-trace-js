'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
describe('esm', () => {
  let agent
  let proc
  let variants

  // test against later versions because server.mjs uses newer package syntax
  withVersions('microgateway-core', 'microgateway-core', '>=3.0.0', version => {
    useSandbox([`'microgateway-core@${version}'`], false, [
      './packages/datadog-plugin-microgateway-core/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    before(async function () {
      variants = varySandbox('server.mjs', 'Gateway', undefined, 'microgateway-core')
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it('is instrumented', async () => {
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)

        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'microgateway.request'), true)
        })
      }).timeout(20000)
    }
  })
})
