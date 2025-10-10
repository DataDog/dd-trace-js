'use strict'

const { join } = require('node:path')

const { assert } = require('chai')

const {
  FakeAgent,
  curlAndAssertMessage,
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
  withVersions('restify', 'restify', '>3', version => {
    insertVersionDep(__dirname, 'restify', version)

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(__dirname, 'server.mjs', agent.port, env)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'restify.request'), true)
      })
    }).timeout(20000)
  })
})
