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
  withVersions('winston', 'winston', '>=3', (version, _, realVersion) => {
    useSandbox([`'winston@${version}'`]
      , false, ['./packages/datadog-plugin-winston/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const hasNamedExports = semver.satisfies(realVersion, '>=3.4.0')

    const variants = varySandbox('server.mjs', {
      bindingName: 'winston',
      packageName: 'winston',
      defaultExport: true,
      namedExports: hasNamedExports ? ['createLogger', 'format', 'transports'] : [],
      namedExportBinding: hasNamedExports ? 'namespace' : undefined,
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          variants[variant],
          agent.port,
          undefined,
          undefined,
          (data) => {
            const jsonObject = JSON.parse(data.toString())
            assert.ok(Object.hasOwn(jsonObject, 'dd'), `Available keys: ${inspect(Object.keys(jsonObject))}`)
          }
        )
      }).timeout(50000)
    }
  })
})
