'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const semver = require('semver')

const {
  FakeAgent,
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

  withVersions('pino', 'pino', (version, _, realVersion) => {
    useSandbox([`'pino@${version}'`],
      false, ['./packages/datadog-plugin-pino/test/integration-test/*'])

    const hasNamedExport = semver.satisfies(realVersion, '>=6.8.0')

    const variants = varySandbox('server.mjs', {
      bindingName: 'pino',
      packageName: 'pino',
      defaultExport: true,
      namedExports: hasNamedExport ? ['pino'] : [],
      namedExportBinding: hasNamedExport ? 'direct' : undefined,
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
      }).timeout(20000)
    }
  })
})
