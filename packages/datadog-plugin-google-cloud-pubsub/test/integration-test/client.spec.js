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
    NODE_OPTIONS: `--loader=${join(__dirname, '..', '..', '..', '..', 'initialize.mjs')}`,
    PUBSUB_EMULATOR_HOST: 'localhost:8081'
  }

  // test against later versions because server.mjs uses newer package syntax
  withVersions('google-cloud-pubsub', '@google-cloud/pubsub', '>=4.0.0', version => {
    insertVersionDep(__dirname, '@google-cloud/pubsub', version)

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'pubsub.request'), true)
      })

      proc = await spawnPluginIntegrationTestProc(__dirname, 'server.mjs', agent.port, undefined, env)

      await res
    }).timeout(20000)
  })
})
