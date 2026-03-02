'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
describe('esm', () => {
  let agent
  let proc
  let variants

  // limit v4 tests while the IITM issue is resolved or a workaround is introduced
  // this is only relevant for `openai` >=4.0 <=4.1
  // issue link: https://github.com/DataDog/import-in-the-middle/issues/60
  withVersions('openai', 'openai', '>=3 <4.0.0 || >4.1.0', (version) => {
    useSandbox(
      [
        `'openai@${version}'`,
        'nock',
        '@openai/agents',
        '@openai/agents-core',
      ],
      false,
      ['./packages/datadog-plugin-openai/test/integration-test/*']
    )

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    before(async function () {
      variants = varySandbox('server.mjs', 'OpenAI', undefined, 'openai')
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(
            checkSpansForServiceName(payload, 'openai.request'),
            true
          )
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          variants[variant],
          agent.port,
          {
            NODE_OPTIONS: '--import dd-trace/initialize.mjs',
          }
        )

        await res
      }).timeout(20000)
    }
  })
})
