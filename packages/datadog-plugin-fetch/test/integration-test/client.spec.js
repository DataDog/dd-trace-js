'use strict'

const {
  FakeAgent,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { join } = require('path')

const describe = globalThis.fetch ? globalThis.describe : globalThis.describe.skip

describe('esm', () => {
  let agent
  let proc
  const env = {
    NODE_OPTIONS: `--loader=${join(__dirname, '..', '..', '..', '..', 'initialize.mjs')}`
  }

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc && proc.kill()
    await agent.stop()
  })

  context('fetch', () => {
    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        const isFetch = payload.some((span) => span.some((nestedSpan) => nestedSpan.meta.component === 'fetch'))
        assert.strictEqual(isFetch, true)
      })

      proc = await spawnPluginIntegrationTestProc(__dirname, 'server.mjs', agent.port, undefined, env)

      await res
    }).timeout(50000)
  })
})
