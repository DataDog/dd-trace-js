'use strict'

const { join } = require('node:path')

const { assert } = require('chai')

const {
  FakeAgent,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const version = require('../../../../version.js')
const { withVersions, insertVersionDep } = require('../../../dd-trace/test/setup/mocha')

// tedious does not support node 20
const describe = version.NODE_MAJOR >= 20
  ? global.describe.skip
  : global.describe

describe('esm', () => {
  let agent
  let proc
  const env = {
    NODE_OPTIONS: `--loader=${join(__dirname, '..', '..', '..', '..', 'initialize.mjs')}`
  }

  // test against later versions because server.mjs uses newer package syntax
  withVersions('tedious', 'tedious', '>=16.0.0', version => {
    insertVersionDep(__dirname, 'tedious', version)

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
        assert.strictEqual(checkSpansForServiceName(payload, 'tedious.request'), true)
      })

      proc = await spawnPluginIntegrationTestProc(__dirname, 'server.mjs', agent.port, env)

      await res
    }).timeout(20000)
  })
})
