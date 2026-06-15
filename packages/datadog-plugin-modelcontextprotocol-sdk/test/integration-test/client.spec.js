'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, before, beforeEach, afterEach } = require('mocha')
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

  withVersions('modelcontextprotocol-sdk', ['@modelcontextprotocol/sdk'], version => {
    useSandbox([
      `@modelcontextprotocol/sdk@${version}`,
      'zod',
    ], false, [
      './packages/datadog-plugin-modelcontextprotocol-sdk/test/integration-test/*',
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    before(async function () {
      variants = varySandbox('server.mjs', 'McpServer', undefined, '@modelcontextprotocol/sdk')
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'mcp.client.tool.call'), true)
          assert.strictEqual(checkSpansForServiceName(payload, 'mcp.server.request'), true)
          assert.strictEqual(checkSpansForServiceName(payload, 'mcp.server.tool.call'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port, {
          NODE_OPTIONS: '--import dd-trace/initialize.mjs',
        })

        await res
      }).timeout(20000)
    }
  })
})
