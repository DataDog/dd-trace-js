'use strict'

const {
  FakeAgent,
  createSandbox,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { expect } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // test against later versions because server.mjs uses newer package syntax
  withVersions('winston', 'winston', '>=3', version => {
    before(async function () {
      sandbox = await createSandbox([`'winston@${version}'`]
        , false, ['./packages/datadog-plugin-winston/test/integration-test/*'])
    }, { timeout: 50000 })

    after(async function () {
      await sandbox.remove()
    }, { timeout: 50000 })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', { timeout: 50000 }, async () => {
      proc = await spawnPluginIntegrationTestProc(
        sandbox.folder,
        'server.mjs',
        agent.port,
        (data) => {
          const jsonObject = JSON.parse(data.toString())
          expect(jsonObject).to.have.property('dd')
        }
      )
    })
  })
})
