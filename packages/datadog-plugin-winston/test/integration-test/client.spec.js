'use strict'

const assert = require('node:assert/strict')
const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  let variants

  // test against later versions because server.mjs uses newer package syntax
  withVersions('winston', 'winston', '>=3', version => {
    useSandbox([`'winston@${version}'`]
      , false, ['./packages/datadog-plugin-winston/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    before(async function () {
      variants = varySandbox('server.mjs', 'winston', undefined)
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it('is instrumented', async () => {
        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          variants[variant],
          agent.port,
          undefined,
          undefined,
          (data) => {
            const jsonObject = JSON.parse(data.toString())
            assert.ok(Object.hasOwn(jsonObject, 'dd'))
          }
        )
      }).timeout(50000)
    }
  })
})
