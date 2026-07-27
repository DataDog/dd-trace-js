'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

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

  // TODO(sabrenner, MLOB-4410): follow-up on re-enabling this test in a different PR once a fix lands
  withVersions('langchain', ['@langchain/core'], '>=0.1 <1.0.0', version => {
    useSandbox([
      `@langchain/core@${version}`,
      `@langchain/openai@${version}`,
    ], false, [
      './packages/datadog-plugin-langchain/test/integration-test/*',
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const variants = varySandbox('server.mjs', {
      bindingName: 'StringOutputParser',
      packageName: '@langchain/core/output_parsers',
      defaultExport: false,
      namedExports: ['StringOutputParser'],
      namedExportBinding: 'direct',
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'langchain.request'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port, {
          NODE_OPTIONS: '--import dd-trace/initialize.mjs',
        })

        await res
      }).timeout(20000)
    }
  })
})
