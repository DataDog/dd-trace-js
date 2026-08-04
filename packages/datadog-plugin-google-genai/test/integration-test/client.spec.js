'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')
const { describe, it, beforeEach, afterEach } = require('mocha')
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

  withVersions('google-genai', ['@google/genai'], version => {
    useSandbox([
      `@google/genai@${version}`,
    ], false, [
      './packages/datadog-plugin-google-genai/test/integration-test/*',
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const variants = varySandbox('server.mjs', {
      bindingName: 'GoogleGenAI',
      packageName: '@google/genai',
      defaultExport: false,
      namedExports: ['GoogleGenAI'],
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
          assert.strictEqual(checkSpansForServiceName(payload, 'google_genai.request'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port, {
          NODE_OPTIONS: '--import dd-trace/initialize.mjs',
          GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || '<not-a-real-key>',
        })

        await res
      }).timeout(20000)
    }
  })
})
