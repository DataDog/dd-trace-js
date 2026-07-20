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
      '@langchain/core@1.1.48',
      '@langchain/langgraph@1.0.0',
      '@langchain/mcp-adapters@1.1.3',
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
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.request'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.resources.list'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.resource.read'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.prompts.list'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.prompt.get'), true)
        assert.strictEqual(checkSpansForServiceName(traces, 'mcp.server.tool.call'), true)
      })

      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server.mjs', agent.port, {
        NODE_OPTIONS: nodeOptions,
      })

      await res
    }).timeout(20000)

    it('deduplicates adapter tool LLMObs spans', async () => {
      const nodeOptions = [
        process.env.NODE_OPTIONS,
        '--import dd-trace/initialize.mjs',
      ].filter(Boolean).join(' ')

      const result = agent.assertLlmObsPayloadReceived(({ payload }) => {
        const spans = payload.flatMap(event => event.spans)
        assert.equal(spans.length, 2)
        assert.ok(spans.some(span => span.name === 'MCP Client List Tools'))
        assert.ok(spans.some(span => span.name === 'mcp__repro__echo'))
        assert.equal(spans.some(span => span.name === 'MCP Client Tool Call: echo'), false)
      }, 20000)

      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'llmobs-server.mjs', agent.port, {
        DD_LLMOBS_ENABLED: 'true',
        DD_LLMOBS_AGENTLESS_ENABLED: 'false',
        DD_LLMOBS_ML_APP: 'test',
        _DD_LLMOBS_FLUSH_INTERVAL: '0',
        NODE_OPTIONS: nodeOptions,
      })

      await result
    }).timeout(30000)
  })
})
