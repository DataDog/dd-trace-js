'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const semver = require('semver')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
describe('esm', () => {
  let agent
  let proc

  // test against later versions because server.mjs uses newer package syntax
  withVersions('mariadb', 'mariadb', '>=3.0.0', (version, _, resolvedVersion) => {
    useSandbox([`'mariadb@${version}'`], false, [
      './packages/datadog-plugin-mariadb/test/integration-test/*'])
    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const variants = varySandbox('server.mjs', {
      bindingName: 'mariadb',
      packageName: 'mariadb',
      defaultExport: true,
      namedExports: ['createPool'],
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
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'mariadb.query'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
