'use strict'

const { join } = require('node:path')

const { assert } = require('chai')

const {
  FakeAgent,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions, insertVersionDep } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  const env = {
    NODE_OPTIONS: `--loader=${join(__dirname, '..', '..', '..', '..', 'initialize.mjs')}`
  }

  // test against later versions because server.mjs uses newer package syntax
  withVersions('couchbase', 'couchbase', '>=4.0.0', version => {
    insertVersionDep(__dirname, 'couchbase', version)

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
        assert.strictEqual(checkSpansForServiceName(payload, 'couchbase.upsert'), true)
      })

      proc = await spawnPluginIntegrationTestProc(__dirname, 'server.mjs', agent.port, env)
      await res
    }).timeout(20000)
  })
})
