'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // excluding 8.16.0 for esm tests, because it is not working: https://github.com/elastic/elasticsearch-js/issues/2466
  withVersions('elasticsearch', ['@elastic/elasticsearch'], '<8.16.0 || >8.16.0', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'@elastic/elasticsearch@${version}'`], false, [
        './packages/datadog-plugin-elasticsearch/test/integration-test/*'])
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
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'elasticsearch.query'), true)
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      await res
    }).timeout(20000)
  })
})
