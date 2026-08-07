'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const semver = require('semver')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
describe('esm', () => {
  let agent
  let proc

  // test against later versions because server.mjs uses newer package syntax
  const range = semver.gte(process.version, '20.0.0') ? '>=3.0.0' : '>=3.0.0 <3.5.3'
  withVersions('mariadb', 'mariadb', range, (version, _, resolvedVersion) => {
    useSandbox([`'mariadb@${version}'`], false, [
      './packages/datadog-plugin-mariadb/test/integration-test/*'])
    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const variants = varySandbox('server.mjs', {
      bindingName: 'mariadb',
      packageName: 'mariadb',
      defaultExport: true,
      namedExports: ['createConnection', 'createPool'],
      namedExportBinding: 'namespace',
    })
    const importVariants = semver.gte(resolvedVersion, '3.5.1')
      ? ['named', 'named-from-namespace']
      : Object.keys(variants)

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of importVariants) {
      it(`is instrumented ${variant}`, async () => {
        const resources = new Set()
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)

          for (const trace of payload) {
            for (const span of trace) {
              if (span.name === 'mariadb.query') resources.add(span.resource)
            }
          }

          assert.deepStrictEqual([...resources].sort(), [
            'SELECT 1 AS pool_query',
            'SELECT 2 AS pool_execute',
            'SELECT 3 AS connection_query',
            'SELECT 4 AS connection_execute',
            'SELECT 5 AS direct_query',
            'SELECT 6 AS direct_execute',
          ])
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
