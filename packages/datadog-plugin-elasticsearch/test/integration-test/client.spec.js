'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')
const semver = require('semver')

const {
  FakeAgent,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  sandboxCwd,
  useSandbox,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc

  // excluding 8.16.0 for esm tests, because it is not working: https://github.com/elastic/elasticsearch-js/issues/2466
  withVersions('elasticsearch', ['@elastic/elasticsearch'], '<8.16.0 || >8.16.0', (version, _, resolvedVersion) => {
    const hasDefaultExport = semver.satisfies(resolvedVersion, '<9.3.2')
    useSandbox([`'@elastic/elasticsearch@${version}'`], false, [
      './packages/datadog-plugin-elasticsearch/test/integration-test/*'])

    const variants = varySandbox(hasDefaultExport ? 'server.mjs' : 'server-v9.mjs', {
      bindingName: hasDefaultExport ? 'elasticsearch' : 'Client',
      packageName: '@elastic/elasticsearch',
      defaultExport: hasDefaultExport,
      namedExports: hasDefaultExport ? [] : ['Client'],
      namedExportBinding: hasDefaultExport ? undefined : 'direct',
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented loaded with ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'elasticsearch.query'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
