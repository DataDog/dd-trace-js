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
  let variants

  withVersions('anthropic-ai-claude-agent-sdk', ['@anthropic-ai/claude-agent-sdk'], version => {
    useSandbox([
      `@anthropic-ai/claude-agent-sdk@${version}`,
    ], false, [
      './packages/datadog-plugin-anthropic-ai-claude-agent-sdk/test/integration-test/*',
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    before(async function () {
      // `query` is named-only (no default export), so only `star` and `destructure` variants.
      variants = varySandbox('server.mjs', 'query', undefined, '@anthropic-ai/claude-agent-sdk', true)
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of ['star', 'destructure']) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(
            checkSpansForServiceName(payload, 'anthropic-ai-claude-agent-sdk.query'),
            true
          )
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port, {
          NODE_OPTIONS: '--import dd-trace/initialize.mjs',
          ANTHROPIC_API_KEY: '<not-a-real-key>',
        })

        await res
      }).timeout(20000)
    }
  })
})
