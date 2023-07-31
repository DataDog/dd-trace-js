'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
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
    sandbox = await createSandbox(['oracledb'], false, [
      `./packages/datadog-plugin-oracledb/test/integration-test/*`])
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

  context('oracledb', () => {
    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        console.log(headers, payload)
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'oracle.query'), true)
      }, undefined)

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port, undefined,
        { CI: process.env.CI })

      await res
    }).timeout(20000)
  })
})
