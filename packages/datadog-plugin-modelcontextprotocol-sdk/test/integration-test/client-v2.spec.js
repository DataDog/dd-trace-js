'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { afterEach, beforeEach, describe, it } = require('mocha')

const {
  FakeAgent,
  checkSpansForServiceName,
  sandboxCwd,
  spawnPluginIntegrationTestProcAndExpectExit,
  stopProc,
  useSandbox,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm with SDK 2.x', () => {
  let agent
  let proc

  withVersions('modelcontextprotocol-server', ['@modelcontextprotocol/server'], version => {
    useSandbox([
      `@modelcontextprotocol/server@${version}`,
      `@modelcontextprotocol/client@${version}`,
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

    it('is instrumented over the 2026-07-28 protocol', async () => {
      const nodeOptions = [
        process.env.NODE_OPTIONS,
        '--import dd-trace/initialize.mjs',
      ].filter(Boolean).join(' ')

      const traces = []
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
        traces.push(...payload)
        const resources = new Set(traces.flat().map(span => span.resource))
        for (const resource of ['client_tool_call', 'server_tool_call', 'ClientSession.list_tools', 'tools/list']) {
          assert.ok(resources.has(resource), `Expected a span with resource ${resource}`)
        }
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.resources.list'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.resource.read'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.prompts.list'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.prompt.get'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.server.tool.call'), true)
      })

      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server-v2.mjs', agent.port, {
        NODE_OPTIONS: nodeOptions,
      })

      await res
    }).timeout(20000)
  })
})
