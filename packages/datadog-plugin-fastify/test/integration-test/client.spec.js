'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // skip older versions of fastify due to syntax differences
  withVersions('fastify', 'fastify', '>=3', (version, _, specificVersion) => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'fastify@${version}'`], false,
        ['./packages/datadog-plugin-fastify/test/integration-test/*'])
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

    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'fastify.request'), true)
      })
    }).timeout(20000)

    it('* import fastify is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server1.mjs', agent.port)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'fastify.request'), true)
      })
    }).timeout(20000)

    it('Fastify import fastify is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server2.mjs', agent.port)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'fastify.request'), true)
      })
    }).timeout(20000)
  })
})
