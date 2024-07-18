'use strict'

const {
  FakeAgent,
  createSandbox,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

const describe = globalThis.fetch ? globalThis.describe : globalThis.describe.skip

describe('esm', () => {
  let agent
  let proc
  let sandbox

  before(async function () {
    sandbox = await createSandbox(['get-port'], false, [
      './packages/datadog-plugin-fetch/test/integration-test/*'])
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

  context('fetch', () => {
    it('is instrumented', { timeout: 50000 }, async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        const isFetch = payload.some((span) => span.some((nestedSpan) => nestedSpan.meta.component === 'fetch'))
        assert.strictEqual(isFetch, true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      await res
    })
  })
})
