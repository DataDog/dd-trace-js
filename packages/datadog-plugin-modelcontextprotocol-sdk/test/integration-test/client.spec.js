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
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc

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

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    it('is instrumented', async () => {
      const nodeOptions = [
        process.env.NODE_OPTIONS,
        '--import dd-trace/initialize.mjs',
      ].filter(Boolean).join(' ')

      const traces = []
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
        traces.push(...payload)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.tools.list'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.client.tool.call'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.resources.list'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.resource.read'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.prompts.list'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.prompt.get'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.server.request'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.server.tool.call'), true)
      })

      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server.mjs', agent.port, {
        NODE_OPTIONS: nodeOptions,
      })

      await res
    }).timeout(20000)
  })
})
