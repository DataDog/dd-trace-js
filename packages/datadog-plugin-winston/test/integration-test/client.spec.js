'use strict'

const assert = require('node:assert/strict')
const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
describe('esm', () => {
  let agent
  let proc

  // test against later versions because server.mjs uses newer package syntax
  withVersions('winston', 'winston', '>=3', version => {
    useSandbox([`'winston@${version}'`]
      , false, ['./packages/datadog-plugin-winston/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(
        sandboxCwd(),
        'server.mjs',
        agent.port,
        (data) => {
          const jsonObject = JSON.parse(data.toString())
          assert.ok(Object.hasOwn(jsonObject, 'dd'))
        }
      )
    }).timeout(50000)
  })
})
