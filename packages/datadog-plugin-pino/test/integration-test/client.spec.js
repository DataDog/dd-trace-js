'use strict'

const assert = require('node:assert/strict')
const {
  FakeAgent,
  spawnPluginIntegrationTestProcAndExpectExit,
  sandboxCwd,
  useSandbox,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  let variants

  withVersions('pino', 'pino', version => {
    useSandbox([`'pino@${version}'`],
      false, ['./packages/datadog-plugin-pino/test/integration-test/*'])

    before(async function () {
      variants = varySandbox('server.mjs', 'pino')
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
        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          variants[variant],
          agent.port,
          (data) => {
            const jsonObject = JSON.parse(data.toString())
            assert.ok(Object.hasOwn(jsonObject, 'dd'))
          }
        )
      }).timeout(20000)
    }
  })
})
