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

<<<<<<< HEAD
  // TODO: fastify instrumentation breaks with esm for version 4.23.2 but works for commonJS,
  // fix it and change the versions tested
  withVersions('fastify', 'fastify', '^3', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'fastify@${version}'`], false,
        [`./packages/datadog-plugin-fastify/test/integration-test/*`])
    })
=======
  before(async function () {
    this.timeout(20000)
    sandbox = await createSandbox(['fastify@^3.0.0'],
      false, [`./packages/datadog-plugin-fastify/test/integration-test/*`])
  })
>>>>>>> 1e1771ce8 (newer versions of fastify break our instrumentations, update esm test to match version of instrumentation)

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

    //
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
