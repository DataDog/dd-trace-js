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

  before(async function () {
    this.timeout(20000)
    sandbox = await createSandbox(['pino'], false, [`./packages/datadog-plugin-pino/test/integration-test/*`])
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

  context('pino', () => {
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
    }).timeout(20000)
  })
})
