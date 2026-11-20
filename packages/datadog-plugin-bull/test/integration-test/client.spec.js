'use strict'

const assert = require('node:assert/strict')

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

  withVersions('bull', 'bull', version => {
    useSandbox([`'bull@${version}'`], false, ['./packages/datadog-plugin-bull/test/integration-test/*'])

    const variants = varySandbox('server.mjs', {
      bindingName: 'Queue',
      packageName: 'bull',
      defaultExport: true,
      namedExports: [],
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
        const names = new Set()
        const received = agent.assertMessageReceived(({ payload }) => {
          for (const span of payload.flat()) names.add(span.name)
          assert.ok(names.has('bull.add'), `bull.add not found in ${[...names]}`)
          assert.ok(names.has('bull.process'), `bull.process not found in ${[...names]}`)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await received
      }).timeout(60000)
    }
  })
})
