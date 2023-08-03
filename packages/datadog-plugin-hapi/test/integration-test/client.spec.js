'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  curlAndAssertMessage,
  skipUnsupportedNodeVersions,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

const describe = skipUnsupportedNodeVersions()

describe('esm', () => {
  let agent
  let proc
  let sandbox

  before(async function () {
    this.timeout(20000)
    sandbox = await createSandbox(['@hapi/hapi'], false, [
      `./packages/datadog-plugin-hapi/test/integration-test/*`])
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

  context('hapi', () => {
    it('is instrumented', async () => {
      console.log('integration', 1)
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)
      console.log('integration', 2)
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'hapi.request'), true)
      })
    }).timeout(20000)
  })
})
