'use strict'

const {
  FakeAgent,
  createSandbox,
  spawnPluginIntegrationTestProc,
  esmTestSkipper
} = require('../../../../integration-tests/helpers')
const { expect } = require('chai')

const describe = esmTestSkipper()

describe('esm', () => {
  let agent
  let proc
  let sandbox

  before(async function () {
    this.timeout(20000)
    sandbox = await createSandbox(['bunyan'], false, [`./packages/datadog-plugin-bunyan/test/integration-test/*`])
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

  context('bunyan', () => {
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
