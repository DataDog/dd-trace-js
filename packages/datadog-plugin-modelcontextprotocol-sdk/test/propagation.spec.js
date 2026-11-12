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

    for (const enabled of [undefined, 'true', '1', 'false', '0']) {
      describe(`DD_MCP_DISTRIBUTED_TRACING=${enabled}`, () => {
        const propagates = enabled !== 'false' && enabled !== '0'
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
          const result = await peer.client.callTool({ name: 'echo', arguments: {} })
          const headers = peer.requests[0].params?._meta?._dd_trace_context
          if (propagates) {
            assert.ok(headers?.['x-datadog-parent-id'])
          } else {
            assert.strictEqual(headers, undefined)
          }
          assert.strictEqual(result.content[0].text, 'echo')
        })

        it('carries an active context on ping without creating an MCP operation span', async () => {
          const parent = tracer.startSpan('ping-parent')
          const traceAssertion = Promise.all([agent.assertNoTraces(traces => {
            assert.strictEqual(traces.flat().some(span => span.type === 'mcp'), false)
          }), agent.assertSomeTraces(traces => {
            const trace = traces.find(trace => {
              return trace.some(span => span.span_id.toString() === parent.context().toSpanId())
            })
            assert.ok(trace)
            assert.strictEqual(trace.length, 1)
            assert.strictEqual(trace[0].name, 'ping-parent')
          })])
          try {
            const result = await tracer.scope().activate(parent, () => peer.client.ping())
            const headers = peer.requests[0].params?._meta?._dd_trace_context
            if (propagates) {
              assert.ok(headers)
              assert.strictEqual(headers['x-datadog-parent-id'], parent.context().toSpanId())
            } else {
              assert.strictEqual(headers, undefined)
            }
            assert.deepStrictEqual(result, {})
          } finally {
            parent.finish()
            await traceAssertion
          }
        })

        it('does not add metadata without an active span', async () => {
          const result = await peer.client.ping()
          assert.strictEqual(peer.requests[0].params?._meta?._dd_trace_context, undefined)
          assert.deepStrictEqual(result, {})
        })

        it('preserves the native falsey request options', async () => {
          const parent = tracer.startSpan('options-parent')
          try {
            for (const options of [undefined, null, 0, false, '', NaN, {}]) {
              const result = await tracer.scope().activate(parent, () => peer.client.ping(options))
              assert.deepStrictEqual(result, {})
              assert.strictEqual(Boolean(peer.requests.at(-1).params?._meta?._dd_trace_context), propagates)
            }
          } finally {
            parent.finish()
          }
        })

        it('respects the switch after disabling and re-enabling the integration', async () => {
          const parent = tracer.startSpan('lifecycle-parent')
          try {
            tracer.use('modelcontextprotocol-sdk', false)
            await tracer.scope().activate(parent, () => peer.client.ping())
            assert.strictEqual(peer.requests[0].params?._meta?._dd_trace_context, undefined)
            tracer.use('modelcontextprotocol-sdk', true)
            await tracer.scope().activate(parent, () => peer.client.ping())
            assert.strictEqual(Boolean(peer.requests[1].params?._meta?._dd_trace_context), propagates)
          } finally {
            tracer.use('modelcontextprotocol-sdk', true)
            parent.finish()
          }
        })

        it('preserves frozen requests and existing metadata when the SDK adds progress metadata', async () => {
          const { CallToolResultSchema } = versionMod.get('@modelcontextprotocol/sdk/types.js')
          const metadata = Object.freeze({ tenant: 'a' })
          const params = Object.freeze({ name: 'echo', arguments: {}, _meta: metadata })
          const request = Object.freeze({ method: 'tools/call', params })
          const parent = tracer.startSpan('metadata-parent')
          try {
            const result = await tracer.scope().activate(parent, () => {
              return peer.client.request(request, CallToolResultSchema, { onprogress () {} })
            })
            assert.deepStrictEqual(metadata, { tenant: 'a' })
            assert.strictEqual(request.params, params)
            assert.strictEqual(params._meta, metadata)
            const received = peer.requests[0].params._meta
            assert.strictEqual(received.tenant, 'a')
            assert.strictEqual(typeof received.progressToken, 'number')
            assert.strictEqual(Boolean(received._dd_trace_context), propagates)
            assert.strictEqual(result.content[0].text, 'echo')
          } finally {
            parent.finish()
          }
        })

        it('controls extraction from an independently supplied carrier while preserving APM spans', async () => {
          const { CallToolResultSchema } = versionMod.get('@modelcontextprotocol/sdk/types.js')
          const remote = tracer.startSpan('remote-parent')
          const headers = {}
          tracer.inject(remote, 'text_map', headers)
          const traceAssertion = agent.assertSomeTraces(traces => {
            const span = traces.flat().find(span => span.resource === 'server_tool_call')
            assert.ok(span)
            if (propagates) {
              assert.strictEqual(span.parent_id.toString(), remote.context().toSpanId())
              assert.strictEqual(span.trace_id.toString(), remote.context().toTraceId())
            } else {
              assert.notStrictEqual(span.trace_id.toString(), remote.context().toTraceId())
              assert.strictEqual(span.parent_id.toString(), '0')
            }
          })
          try {
            const result = await peer.client.request({
              method: 'tools/call',
              params: { name: 'echo', arguments: {}, _meta: { _dd_trace_context: headers } },
            }, CallToolResultSchema)
            assert.strictEqual(result.content[0].text, 'echo')
          } finally {
            remote.finish()
          }
          await traceAssertion
        })

        it('preserves native promise rejections for disconnected and aborted requests', async () => {
          const { EmptyResultSchema } = versionMod.get('@modelcontextprotocol/sdk/types.js')
          const controller = new AbortController()
          controller.abort(new Error('request aborted'))
          const parent = tracer.startSpan('rejected-parent')
          try {
            await assert.rejects(() => tracer.scope().activate(parent, () => {
              return peer.client.ping({ signal: controller.signal })
            }), { message: 'request aborted' })
            await peer.client.close()
            await assert.rejects(() => tracer.scope().activate(parent, () => peer.client.ping()), {
              message: 'Not connected',
            })
            for (const request of [undefined, null, { method: 1 }]) {
              await assert.rejects(() => tracer.scope().activate(parent, () => {
                return peer.client.request(request, EmptyResultSchema)
              }), { message: 'Not connected' })
            }
          } finally {
            parent.finish()
          }
        })

        it('preserves the transport parent when metadata extraction is disabled', async () => {
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
