'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
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

  withVersions('google-genai', ['@google/genai'], version => {
    useSandbox([
      `@google/genai@${version}`,
    ], false, [
      './packages/datadog-plugin-google-genai/test/integration-test/*'
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    before(async function () {
      variants = varySandbox('server.mjs', 'genLib', 'GoogleGenAI', '@google/genai')
    })

    afterEach(async () => {
      proc?.kill()
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it('is instrumented', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'google_genai.request'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variant[variants], agent.port, {
          NODE_OPTIONS: '--import dd-trace/initialize.mjs',
          GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || '<not-a-real-key>'
        })

        await res
      }).timeout(20000)
    }
  })
})
