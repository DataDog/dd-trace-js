'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  before(async function () {
    this.timeout(20000)
    sandbox = await createSandbox(['@google-cloud/pubsub'], false, [ './packages/dd-trace/src/id.js',
      `./packages/datadog-plugin-google-cloud-pubsub/test/integration-test/*`])
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

  context('google-cloud-pubsub', () => {
    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'pubsub.request'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port, undefined,
        { PUBSUB_EMULATOR_HOST: 'localhost:8081' })

      await res
    }).timeout(20000)
  })
})
