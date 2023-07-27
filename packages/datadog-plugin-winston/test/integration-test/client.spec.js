'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
  skipUnsupportedNodeVersions,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { expect } = require('chai')

const describe = skipUnsupportedNodeVersions()

describe('esm', () => {
  let agent
  let proc
  let sandbox

  before(async function () {
    this.timeout(20000)
    sandbox = await createSandbox(['winston'], false, [`./integration-tests/plugin-helpers.mjs`,
      `./packages/datadog-plugin-winston/test/integration-test/*`])
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

  context('winston', () => {
    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      return curlAndAssertMessage(agent, proc, () => {
        proc.stdout.on('data', (data) => {
          const jsonObject = JSON.parse(data.toString())
          expect(jsonObject).to.have.property('dd')
          expect(jsonObject).to.deep.nested.property('dd.trace_id')
          expect(jsonObject).to.deep.nested.property('dd.span_id')
        })
      })
    }).timeout(20000)
  })
})
