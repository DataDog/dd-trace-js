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

  // skip older versions of fastify due to syntax differences
  withVersions('fastify', 'fastify', '>=3', (version, _, specificVersion) => {
    insertVersionDep(__dirname, 'fastify', version)

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
        assert.strictEqual(checkSpansForServiceName(payload, 'fastify.request'), true)
      })
    }).timeout(20000)

    it('* import fastify is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(__dirname, 'server1.mjs', agent.port, env)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'fastify.request'), true)
      })
    }).timeout(20000)

    it('Fastify import fastify is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(__dirname, 'server2.mjs', agent.port, env)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'fastify.request'), true)
      })
    }).timeout(20000)
  })
})
