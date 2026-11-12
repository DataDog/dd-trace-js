'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, beforeEach, afterEach } = require('mocha')
const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProcAndExpectExit,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

const CLIENT_RESOURCES = [
  'client_tool_call',
  'ClientSession.list_tools',
  'resources/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
]

describe('esm with @modelcontextprotocol/client 2.x', () => {
  let agent
  let proc

  withVersions('modelcontextprotocol-sdk', ['@modelcontextprotocol/client'], version => {
    useSandbox([
      `@modelcontextprotocol/client@${version}`,
      `@modelcontextprotocol/server@${version}`,
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

      const spans = []
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
        spans.push(...payload.flat())

        const clientResources = new Set(spans.filter(span => span.meta['span.kind'] === 'client')
          .map(span => span.resource))
        for (const resource of CLIENT_RESOURCES) {
          assert.ok(clientResources.has(resource), `Expected a client span with resource ${resource}`)
        }

        const clientSpan = spans.find(span => span.resource === 'client_tool_call')
        const serverSpan = spans.find(span => span.resource === 'server_tool_call')
        assert.ok(serverSpan, 'Expected a server tool call span')
        assert.strictEqual(serverSpan.parent_id.toString(), clientSpan.span_id.toString())
      })

      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'client-v2.mjs', agent.port, {
        NODE_OPTIONS: nodeOptions,
      })

      await res
    }).timeout(20000)
  })
})
