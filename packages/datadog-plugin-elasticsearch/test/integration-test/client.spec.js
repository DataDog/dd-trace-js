'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  sandboxCwd,
  useSandbox,
  varySandbox,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  let variants

  // excluding 8.16.0 for esm tests, because it is not working: https://github.com/elastic/elasticsearch-js/issues/2466
  withVersions('elasticsearch', ['@elastic/elasticsearch'], '<8.16.0 || >8.16.0', (version, _, resolvedVersion) => {
    useSandbox([`'@elastic/elasticsearch@${version}'`], false, [
      './packages/datadog-plugin-elasticsearch/test/integration-test/*'])

    before(async function () {
      const hasDefaultExport = !resolvedVersion.startsWith('9.')
      if (hasDefaultExport) {
        variants = varySandbox('server.mjs', 'elasticsearch', undefined, '@elastic/elasticsearch')
      } else {
        variants = varySandbox('server-v9.mjs', 'Client', undefined, '@elastic/elasticsearch', true)
      }
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented loaded with ${variant}`, async function () {
        if (!variants[variant]) {
          this.skip()
        }

        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'elasticsearch.query'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
