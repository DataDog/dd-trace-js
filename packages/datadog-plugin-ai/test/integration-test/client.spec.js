'use strict'

const assert = require('node:assert/strict')

const semifies = require('semifies')
const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

function getOpenaiVersion (realVersion) {
  if (semifies(realVersion, '>=5.0.0')) {
    return '2.0.0'
  }
  return '1.3.23'
}

describe('esm', () => {
  let agent
  let proc
  let variants

  withVersions('ai', 'ai', (version, _, realVersion) => {
    useSandbox([
      `ai@${version}`,
      `@ai-sdk/openai@${getOpenaiVersion(realVersion)}`,
      'zod@3.25.75'
    ], false, [
      './packages/datadog-plugin-ai/test/integration-test/*'
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    before(async function () {
      variants = varySandbox('server.mjs', 'generateText', undefined, 'ai', true)
    })

    afterEach(async () => {
      proc?.kill()
      await agent.stop()
    })

    for (const variant of ['star', 'destructure']) {
      it('is instrumented', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))

          // special check for ai spans
          for (const spans of payload) {
            for (const span of spans) {
              if (span.name.startsWith('ai')) {
                return
              }
            }
          }

          assert.fail('No ai spans found')
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port, {
          NODE_OPTIONS: '--import dd-trace/initialize.mjs'
        })

        await res
      }).timeout(20000)
    }
  })
})
