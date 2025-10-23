'use strict'

const {
  FakeAgent,
  linkedSandbox,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { expect } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // test against later versions because server.mjs uses newer package syntax
  withVersions('winston', 'winston', '>=3', version => {
    before(async function () {
      this.timeout(50000)
      sandbox = await linkedSandbox([`'winston@${version}'`]
        , false, ['./packages/datadog-plugin-winston/test/integration-test/*'])
    })

    after(async function () {
      this.timeout(50000)
      await sandbox.remove()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(
        sandbox.folder,
        'server.mjs',
        agent.port,
        (data) => {
          const jsonObject = JSON.parse(data.toString())
          expect(jsonObject).to.have.property('dd')
        }
      )
    }).timeout(50000)
  })
})
