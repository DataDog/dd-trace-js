'use strict'

const {
  FakeAgent,
  createSandbox,
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
    sandbox = await createSandbox(['http2'], false, [`./integration-tests/plugin-helpers.mjs`,
      `./packages/datadog-plugin-http2/test/*`])
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

  context('http2', () => {
    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'integration-test/server.mjs', agent.port)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, 1)
        assert.propertyVal(payload[0][0], 'name', 'web.request')
        assert.propertyVal(payload[0][0].meta, 'component', 'http2')
      }, undefined, true)
    }).timeout(20000)
  })
})
