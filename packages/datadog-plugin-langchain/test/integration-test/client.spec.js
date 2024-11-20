'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

// there is currently an issue with langchain + esm loader hooks from IITM
// https://github.com/nodejs/import-in-the-middle/issues/163
describe.skip('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('langchain', ['@langchain/core'], '>=0.1', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([
        `@langchain/core@${version}`,
        `@langchain/openai@${version}`,
        'nock'
      ], false, [
        './packages/datadog-plugin-langchain/test/integration-test/*'
      ])
    })

    after(async () => {
      await sandbox.remove()
    })

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
        assert.strictEqual(checkSpansForServiceName(payload, 'langchain.request'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      await res
    }).timeout(20000)
  })
})
