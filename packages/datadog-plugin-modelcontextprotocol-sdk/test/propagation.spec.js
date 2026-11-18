'use strict'

const assert = require('node:assert/strict')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

/**
 * @param {string} version
 * @param {import('../../../').Tracer} tracer
 * @param {import('../../../').Span | null} [receiveSpan]
 */
async function createPeer (version, tracer, receiveSpan = null) {
  const versionMod = require(`../../../versions/@modelcontextprotocol/sdk@${version}`)
  const { Client } = versionMod.get('@modelcontextprotocol/sdk/client')
  const { McpServer } = versionMod.get('@modelcontextprotocol/sdk/server/mcp.js')
  const { InMemoryTransport } = versionMod.get('@modelcontextprotocol/sdk/inMemory.js')
  const server = new McpServer({ name: 'propagation-server', version: '1.0.0' })
  server.registerTool('echo', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'echo' }] }))

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const requests = []
  await server.connect(serverTransport)
  const onmessage = serverTransport.onmessage
  serverTransport.onmessage = tracer.scope().bind((...args) => {
    if (args[0].method) requests.push(args[0])
    return onmessage.apply(serverTransport, args)
  }, receiveSpan)
  const client = new Client({ name: 'propagation-client', version: '1.0.0' })
  await client.connect(clientTransport)
  requests.length = 0

  return {
    client,
    requests,
    async close () {
      await Promise.all([client.close(), server.close()])
    },
  }
}

describe('MCP distributed tracing', () => {
  withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', version => {
    const versionMod = require(`../../../versions/@modelcontextprotocol/sdk@${version}`)
    let tracer
    let peer

    for (const enabled of [undefined, 'false']) {
      describe(`DD_MCP_DISTRIBUTED_TRACING=${enabled}`, () => {
        const propagates = enabled === undefined
        let previous

        before(async () => {
          previous = process.env.DD_MCP_DISTRIBUTED_TRACING
          if (enabled === undefined) {
            delete process.env.DD_MCP_DISTRIBUTED_TRACING
          } else {
            process.env.DD_MCP_DISTRIBUTED_TRACING = enabled
          }
          await agent.load('modelcontextprotocol-sdk')
          tracer = require('../../dd-trace')
        })

        after(async () => {
          await agent.close()
          if (previous === undefined) {
            delete process.env.DD_MCP_DISTRIBUTED_TRACING
          } else {
            process.env.DD_MCP_DISTRIBUTED_TRACING = previous
          }
        })

        beforeEach(async () => {
          peer = await createPeer(version, tracer)
        })

        afterEach(async () => {
          await peer.close()
        })

        it('controls tool request injection while preserving the tool result', async () => {
          const resources = new Set()
          const traceAssertion = agent.assertSomeTraces(traces => {
            for (const span of traces.flat()) resources.add(span.resource)
            assert.ok(resources.has('client_tool_call'))
            assert.ok(resources.has('server_tool_call'))
          })
          const [result] = await Promise.all([
            peer.client.callTool({ name: 'echo', arguments: {} }),
            traceAssertion,
          ])
          const headers = peer.requests[0].params?._meta?._dd_trace_context
          if (propagates) {
            assert.ok(headers?.['x-datadog-parent-id'])
          } else {
            assert.strictEqual(headers, undefined)
          }
          assert.strictEqual(result.content[0].text, 'echo')
        })

        it('respects the switch after disabling and re-enabling the integration', async () => {
          const { ListToolsResultSchema } = versionMod.get('@modelcontextprotocol/sdk/types.js')
          const listTools = () => peer.client.request({ method: 'tools/list' }, ListToolsResultSchema)
          const parent = tracer.startSpan('lifecycle-parent')
          try {
            tracer.use('modelcontextprotocol-sdk', false)
            await tracer.scope().activate(parent, listTools)
            assert.strictEqual(peer.requests[0].params?._meta?._dd_trace_context, undefined)
            tracer.use('modelcontextprotocol-sdk', true)
            await tracer.scope().activate(parent, listTools)
            assert.strictEqual(Boolean(peer.requests[1].params?._meta?._dd_trace_context), propagates)
          } finally {
            tracer.use('modelcontextprotocol-sdk', true)
            parent.finish()
          }
        })

        it('chooses between an independently supplied carrier and the transport parent', async () => {
          const { CallToolResultSchema } = versionMod.get('@modelcontextprotocol/sdk/types.js')
          const transport = tracer.startSpan('transport-parent')
          const remote = tracer.startSpan('remote-parent')
          const headers = {}
          tracer.inject(remote, 'text_map', headers)
          await peer.close()
          peer = await createPeer(version, tracer, transport)
          const expected = propagates ? remote : transport
          const traceAssertion = agent.assertSomeTraces(traces => {
            const span = traces.flat().find(span => span.resource === 'server_tool_call')
            assert.ok(span)
            assert.strictEqual(span.parent_id.toString(), expected.context().toSpanId())
            assert.strictEqual(span.trace_id.toString(), expected.context().toTraceId())
          })
          try {
            const result = await peer.client.request({
              method: 'tools/call',
              params: { name: 'echo', arguments: {}, _meta: { _dd_trace_context: headers } },
            }, CallToolResultSchema)
            assert.strictEqual(result.content[0].text, 'echo')
          } finally {
            remote.finish()
            transport.finish()
          }
          await traceAssertion
        })
      })
    }
  })
})
