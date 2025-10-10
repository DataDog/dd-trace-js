'use strict'

const {
  FakeAgent,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions, insertVersionDep } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')
const { join } = require('path')

describe('esm', () => {
  let agent
  let proc
  const env = {
    NODE_OPTIONS: `--loader=${join(__dirname, '..', '..', '..', '..', 'initialize.mjs')}`
  }

  withVersions('google-cloud-vertexai', '@google-cloud/vertexai', '>=1', version => {
    insertVersionDep(__dirname, '@google-cloud/vertexai', version)

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
        assert.strictEqual(checkSpansForServiceName(payload, 'vertexai.request'), true)
      })

      proc = await spawnPluginIntegrationTestProc(__dirname, 'server.mjs', agent.port, undefined, env)

      await res
    }).timeout(20000)
  })
})
