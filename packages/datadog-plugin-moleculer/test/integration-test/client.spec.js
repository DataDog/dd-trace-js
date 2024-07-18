'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { NODE_MAJOR } = require('../../../../version')

// TODO: update this to skip based on package version and tracer version
const describe = NODE_MAJOR < 16 ? globalThis.describe.skip : globalThis.describe

describe('esm', () => {
  let agent
  let proc
  let sandbox
  // test against later versions because server.mjs uses newer package syntax
  withVersions('moleculer', 'moleculer', '>0.14.0', version => {
    before(async function () {
      sandbox = await createSandbox([`'moleculer@${version}'`, 'get-port'], false, [
        './packages/datadog-plugin-moleculer/test/integration-test/*'])
    }, { timeout: 20000 })

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

    it('is instrumented', { timeout: 20000 }, async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'moleculer.action'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      await res
    })
  })
})
