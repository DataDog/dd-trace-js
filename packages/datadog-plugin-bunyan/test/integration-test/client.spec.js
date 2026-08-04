'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')
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

  withVersions('bunyan', 'bunyan', version => {
    useSandbox([`'bunyan@${version}'`], false,
      ['./packages/datadog-plugin-bunyan/test/integration-test/*'])

    const variants = varySandbox('server.mjs', {
      bindingName: 'bunyan',
      packageName: 'bunyan',
      defaultExport: true,
      namedExports: ['createLogger'],
      namedExportBinding: 'namespace',
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
