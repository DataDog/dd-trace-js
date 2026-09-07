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

  withVersions('light-my-request', 'light-my-request', (version, _, realVersion) => {
    useSandbox([`'light-my-request@${version}'`], false, [
      './packages/datadog-plugin-light-my-request/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const hasNamedExport = semver.satisfies(realVersion, '>=4.0.0')

    const variants = varySandbox('server.mjs', {
      bindingName: 'inject',
      packageName: 'light-my-request',
      defaultExport: true,
      namedExports: hasNamedExport ? ['inject'] : [],
      namedExportBinding: hasNamedExport ? 'direct' : undefined,
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented ${variant}`, async () => {
        agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'web.request'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)
      }).timeout(20000)
    }
  })
})
