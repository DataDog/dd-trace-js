'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
describe('esm', () => {
  let agent
  let proc
  let variants

  // TODO(sabrenner, MLOB-4410): follow-up on re-enabling this test in a different PR once a fix lands
  withVersions('langchain', ['@langchain/core'], '>=0.1 <1.0.0', version => {
    useSandbox([
      `@langchain/core@${version}`,
      `@langchain/openai@${version}`,
    ], false, [
      './packages/datadog-plugin-langchain/test/integration-test/*'
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    before(async function () {
      variants = varySandbox('server.mjs', 'StringOutputParser', undefined, '@langchain/core/output_parsers', true)
    })

    afterEach(async () => {
      proc?.kill()
      await agent.stop()
    })

    for (const variant of ['star', 'destructure']) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'langchain.request'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port, {
          NODE_OPTIONS: '--import dd-trace/initialize.mjs'
        })

        await res
      }).timeout(20000)
    }
  })
})
