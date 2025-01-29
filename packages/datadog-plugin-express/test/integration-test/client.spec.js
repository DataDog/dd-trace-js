'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const semver = require('semver')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('express', 'express', version => {
    before(async function () {
      this.timeout(50000)
      sandbox = await createSandbox([`'express@${version}'`], false,
        ['./packages/datadog-plugin-express/test/integration-test/*'])
    })

    after(async function () {
      this.timeout(50000)
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
      delete process.env.DD_TRACE_MIDDLEWARE_ENABLED
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)
      const numberOfSpans = semver.intersects(version, '<5.0.0') ? 4 : 3

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, numberOfSpans)
        assert.propertyVal(payload[0][0], 'name', 'express.request')
        assert.propertyVal(payload[0][1], 'name', 'express.middleware')
      })
    }).timeout(50000)

    it('disables middleware spans when config.middlewareTracingEnabled is set to false through environment variable', async () => {
      process.env.DD_TRACE_MIDDLEWARE_ENABLED = false
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)
      const numberOfSpans = 1

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, numberOfSpans)
        assert.propertyVal(payload[0][0], 'name', 'express.request')
      })
    }).timeout(50000)
  })
})
