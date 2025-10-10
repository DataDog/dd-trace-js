'use strict'

const {
  FakeAgent,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions, insertVersionDep } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const { join } = require('path')

describe('esm', () => {
  let agent
  let proc
  const env = {
    NODE_OPTIONS: `--loader=${join(__dirname, '..', '..', '..', '..', 'initialize.mjs')}`,
    ANTHROPIC_API_KEY: '<not-a-real-key>'
  }

  withVersions('anthropic', ['@anthropic-ai/sdk'], version => {
    insertVersionDep(__dirname, '@anthropic-ai/sdk', version)

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc?.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'anthropic.request'), true)
      })

      proc = await spawnPluginIntegrationTestProc(__dirname, 'server.mjs', agent.port, null, env)

      await res
    }).timeout(20000)
  })
})
