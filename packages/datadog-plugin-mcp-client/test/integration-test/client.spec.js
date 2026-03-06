'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

function findSpan (payload, spanName) {
  for (const trace of payload) {
    for (const span of trace) {
      if (span.name === spanName) return span
    }
  }
  return undefined
}

describe('esm', () => {
  let agent
  let proc

  withVersions('mcp-client', 'mcp-client', version => {
    useSandbox([
      `'mcp-client@${version}'`,
    ], false, [
      './packages/datadog-plugin-mcp-client/test/integration-test/*',
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc?.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      const spanNames = new Set()
      const expectedSpans = [
        'mcp-client.callTool',
        'mcp-client.getResource',
        'mcp-client.getPrompt',
        'mcp-client.complete',
      ]

      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload))
        for (const name of expectedSpans) {
          if (checkSpansForServiceName(payload, name)) {
            spanNames.add(name)
          }
        }
        if (spanNames.size >= expectedSpans.length) return
        throw new Error(
          `Waiting for all spans: have ${spanNames.size}/${expectedSpans.length} (${[...spanNames].join(', ')})`
        )
      })

      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server.mjs', agent.port, {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
      })

      await res
    }).timeout(60000)

    it('has correct span metadata and resource names', async () => {
      const collectedSpans = new Map()
      const expectedSpans = [
        'mcp-client.callTool',
        'mcp-client.getResource',
        'mcp-client.getPrompt',
        'mcp-client.complete',
      ]

      const res = agent.assertMessageReceived(({ payload }) => {
        assert.ok(Array.isArray(payload))
        for (const name of expectedSpans) {
          if (!collectedSpans.has(name)) {
            const span = findSpan(payload, name)
            if (span) collectedSpans.set(name, span)
          }
        }
        if (collectedSpans.size < expectedSpans.length) {
          throw new Error(
            `Waiting for all spans: have ${collectedSpans.size}/${expectedSpans.length}`
          )
        }

        // Verify common metadata on all spans
        for (const [name, span] of collectedSpans) {
          assert.ok(span.meta, `${name}: span should have meta`)
          assert.strictEqual(span.meta.component, 'mcp-client', `${name}: component`)
          assert.strictEqual(span.meta['span.kind'], 'client', `${name}: span.kind`)
        }

        // Verify operation-specific resource names
        const callToolSpan = collectedSpans.get('mcp-client.callTool')
        assert.strictEqual(callToolSpan.resource, 'echo', 'callTool resource should be tool name')
        assert.strictEqual(callToolSpan.meta['mcp.tool.name'], 'echo', 'callTool should tag tool name')

        const getResourceSpan = collectedSpans.get('mcp-client.getResource')
        assert.strictEqual(getResourceSpan.resource, 'file:///test/resource', 'getResource resource should be URI')
        assert.strictEqual(getResourceSpan.meta['mcp.resource.uri'], 'file:///test/resource',
          'getResource should tag URI')

        const getPromptSpan = collectedSpans.get('mcp-client.getPrompt')
        assert.strictEqual(getPromptSpan.resource, 'test-prompt', 'getPrompt resource should be prompt name')
        assert.strictEqual(getPromptSpan.meta['mcp.prompt.name'], 'test-prompt', 'getPrompt should tag prompt name')

        const completeSpan = collectedSpans.get('mcp-client.complete')
        assert.strictEqual(completeSpan.resource, 'test-prompt', 'complete resource should be ref name')
        assert.strictEqual(completeSpan.meta['mcp.completion.ref'], 'ref/prompt', 'complete should tag ref type')
        assert.strictEqual(completeSpan.meta['mcp.completion.name'], 'test-prompt', 'complete should tag ref name')
      })

      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server.mjs', agent.port, {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
      })

      await res
    }).timeout(60000)

    describe('context propagation', () => {
      it('should inject trace context and create child spans under a parent span', async () => {
        const collectedSpans = new Map()
        const expectedMcpSpans = [
          'mcp-client.callTool',
          'mcp-client.getResource',
          'mcp-client.getPrompt',
          'mcp-client.complete',
        ]

        const res = agent.assertMessageReceived(({ payload }) => {
          assert.ok(Array.isArray(payload))
          for (const trace of payload) {
            for (const span of trace) {
              if (span.name === 'test.root' || expectedMcpSpans.includes(span.name)) {
                if (!collectedSpans.has(span.name) || span.name === 'test.root') {
                  collectedSpans.set(span.name, span)
                }
              }
            }
          }

          // Need the root span + all 4 MCP spans
          if (!collectedSpans.has('test.root') || collectedSpans.size < expectedMcpSpans.length + 1) {
            throw new Error(
              `Waiting for all spans: have ${collectedSpans.size}/${expectedMcpSpans.length + 1}`
            )
          }

          const rootSpan = collectedSpans.get('test.root')

          for (const name of expectedMcpSpans) {
            const mcpSpan = collectedSpans.get(name)
            assert.ok(mcpSpan, `${name}: span should exist`)

            // All MCP spans should share the same trace_id as the root span
            assert.strictEqual(
              mcpSpan.trace_id.toString(),
              rootSpan.trace_id.toString(),
              `${name}: should share trace_id with root span`
            )

            // Each MCP span should be a child of the root span
            assert.strictEqual(
              mcpSpan.parent_id.toString(),
              rootSpan.span_id.toString(),
              `${name}: should be a child of root span`
            )
          }
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(), 'server-context-propagation.mjs', agent.port, {
            DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
          }
        )

        await res
      }).timeout(60000)
    })

    describe('peer service', () => {
      it('should set peer.service from mcp.server.name tag', async () => {
        let callToolSpan

        const res = agent.assertMessageReceived(({ payload }) => {
          assert.ok(Array.isArray(payload))
          for (const trace of payload) {
            for (const span of trace) {
              if (span.name === 'mcp-client.callTool') {
                callToolSpan = span
              }
            }
          }

          if (!callToolSpan) {
            throw new Error('Waiting for mcp-client.callTool span')
          }

          // The MCP server name should be tagged
          assert.strictEqual(
            callToolSpan.meta['mcp.server.name'], 'test-server',
            'should tag the MCP server name'
          )

          // peer.service should be derived from mcp.server.name
          assert.strictEqual(
            callToolSpan.meta['peer.service'], 'test-server',
            'peer.service should equal the MCP server name'
          )

          // The source should indicate where peer.service came from
          assert.strictEqual(
            callToolSpan.meta['_dd.peer.service.source'], 'mcp.server.name',
            'peer service source should be mcp.server.name'
          )
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(), 'server-peer-service.mjs', agent.port, {
            DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
            DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED: 'true',
          }
        )

        await res
      }).timeout(60000)
    })

    it('captures errors on spans', async () => {
      const callToolSpans = []

      const res = agent.assertMessageReceived(({ payload }) => {
        assert.ok(Array.isArray(payload))
        for (const trace of payload) {
          for (const span of trace) {
            if (span.name === 'mcp-client.callTool') {
              callToolSpans.push(span)
            }
          }
        }
        // Expect 2 callTool spans: one successful, one errored (after close)
        if (callToolSpans.length < 2) {
          throw new Error(
            `Waiting for callTool spans: have ${callToolSpans.length}/2`
          )
        }

        const errorSpan = callToolSpans.find(s => s.error)
        assert.ok(errorSpan, 'should have an error span for callTool after close')
        assert.ok(errorSpan.meta['error.message'], 'error span should have error.message')
        assert.ok(errorSpan.meta['error.type'], 'error span should have error.type')
      })

      proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server-error.mjs', agent.port, {
        DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
      })

      await res
    }).timeout(60000)
  })
})
