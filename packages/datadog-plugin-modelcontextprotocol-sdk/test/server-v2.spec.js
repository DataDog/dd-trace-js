'use strict'

const assert = require('node:assert/strict')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')

const SERVER_REQUEST_META = {
  component: 'modelcontextprotocol_server',
  '_dd.integration': 'modelcontextprotocol_server',
  'span.kind': 'server',
}

/**
 * @param {Array<Array<{ name: string, resource: string }>>} traces
 * @param {string} name
 * @param {string} resource
 */
function findSpan (traces, name, resource) {
  return traces.flat().find(span => span.name === name && span.resource === resource)
}

describe('Plugin', () => {
  describe('modelcontextprotocol-sdk with @modelcontextprotocol/server 2.x', () => {
    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/server', '>=2', version => {
      let tracer
      let server
      let clientModule

      before(async () => {
        await agent.load('modelcontextprotocol-sdk')
        tracer = require('../../dd-trace')
        server = require(`../../../versions/@modelcontextprotocol/server@${version}`).get()
        clientModule = require('../../../versions/@modelcontextprotocol/client@2').get()
      })

      after(() => agent.close({ ritmReset: false }))

      /**
       * @param {object} mcpServer
       */
      function registerTools (mcpServer) {
        mcpServer.registerTool('test-tool', { description: 'A test tool', inputSchema: {} }, async () => ({
          content: [{ type: 'text', text: 'Result from test-tool' }],
        }))
        mcpServer.registerTool('error-tool', { description: 'A failing tool', inputSchema: {} }, async () => {
          throw new Error('Intentional test error')
        })
        mcpServer.registerTool('confirm-tool', { description: 'Confirm', inputSchema: {} }, async (args, ctx) => {
          if (server.acceptedContent(ctx.mcpReq.inputResponses, 'confirm')?.ok === true) {
            return { content: [{ type: 'text', text: 'confirmed' }] }
          }
          return server.inputRequired({
            inputRequests: {
              confirm: server.inputRequired.elicit({
                message: 'Confirm?',
                requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
              }),
            },
          })
        })
        mcpServer.registerResource('broken-resource', 'file:///broken.txt', { mimeType: 'text/plain' }, async () => {
          throw new Error('Resource read failed')
        })
        return mcpServer
      }

      describe('stateful', () => {
        let mcpServer
        let client

        beforeEach(async () => {
          mcpServer = registerTools(new server.McpServer({ name: 'test-server', version: '1.0.0' }))
          const [clientTransport, serverTransport] = server.InMemoryTransport.createLinkedPair()
          await mcpServer.connect(serverTransport)
          client = new clientModule.Client({ name: 'test-client', version: '1.0.0' })
          await client.connect(clientTransport)
        })

        afterEach(async () => {
          await client.close()
          await mcpServer.close()
        })

        it('traces a tool call with a request span and a tool span', async () => {
          const traceAssertion = agent.assertSomeTraces(traces => {
            const requestSpan = findSpan(traces, 'mcp.request', 'server_tool_call')
            const toolSpan = findSpan(traces, 'mcp.server.tool.call', 'test-tool')

            assert.ok(requestSpan)
            assert.ok(toolSpan)
            assert.equal(requestSpan.meta.component, 'modelcontextprotocol_server')
            assert.equal(requestSpan.meta['span.kind'], 'server')
            assert.equal(requestSpan.error, 0)
            assert.equal(toolSpan.meta.component, 'modelcontextprotocol_server_tool')
            assert.equal(toolSpan.parent_id.toString(), requestSpan.span_id.toString())
          })

          await Promise.all([traceAssertion, client.callTool({ name: 'test-tool', arguments: {} })])
        })

        it('tags an isError tool result as an error', async () => {
          const traceAssertion = expectSomeSpan(agent, {
            name: 'mcp.request',
            resource: 'server_tool_call',
            error: 1,
            meta: { ...SERVER_REQUEST_META, 'error.message': 'Intentional test error' },
          })

          const [, result] = await Promise.all([traceAssertion, client.callTool({ name: 'error-tool', arguments: {} })])
          assert.equal(result.isError, true)
        })

        it('tags a handler that rejects as an error', async () => {
          const traceAssertion = expectSomeSpan(agent, {
            name: 'mcp.request',
            resource: 'resources/read',
            error: 1,
            meta: { ...SERVER_REQUEST_META, 'error.message': 'Resource read failed' },
          })

          await Promise.all([traceAssertion, assert.rejects(client.readResource({ uri: 'file:///broken.txt' }))])
        })

        it('traces tools/list', async () => {
          const traceAssertion = expectSomeSpan(agent, {
            name: 'mcp.request',
            resource: 'tools/list',
            error: 0,
            meta: SERVER_REQUEST_META,
          })

          await Promise.all([traceAssertion, client.listTools()])
        })

        it('follows a tool rename in the tool span resource', async () => {
          const tool = mcpServer.registerTool('old-name', { description: 'Renamed', inputSchema: {} }, async () => ({
            content: [{ type: 'text', text: 'renamed' }],
          }))
          tool.update({ name: 'new-name' })

          const traceAssertion = expectSomeSpan(agent, { name: 'mcp.server.tool.call', resource: 'new-name' })

          await Promise.all([traceAssertion, client.callTool({ name: 'new-name', arguments: {} })])
        })

        it('tags a request whose connection closed before the handler settled', async () => {
          let resume
          const held = new Promise(resolve => { resume = resolve })
          let markStarted
          const started = new Promise(resolve => { markStarted = resolve })
          mcpServer.registerTool('slow-tool', { description: 'Slow', inputSchema: {} }, async () => {
            markStarted()
            await held
            return { content: [{ type: 'text', text: 'late' }] }
          })

          const traceAssertion = expectSomeSpan(agent, {
            name: 'mcp.request',
            resource: 'server_tool_call',
            error: 1,
            meta: { ...SERVER_REQUEST_META, 'error.message': 'Connection closed' },
          })

          await Promise.all([traceAssertion, (async () => {
            const call = client.callTool({ name: 'slow-tool', arguments: {} }).catch(() => {})
            await started
            await mcpServer.close()
            resume()
            await call
          })()])
        })
      })

      describe('stateless', () => {
        let handler
        let client

        beforeEach(async () => {
          handler = server.createMcpHandler(() => registerTools(new server.McpServer({
            name: 'stateless-server',
            version: '1.0.0',
          })))
          // Clear the active span so the server span can only get its parent from `_meta`.
          const transport = new clientModule.StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
            fetch: (url, init) => tracer.scope().activate(null, () => handler.fetch(new Request(url, init))),
          })
          client = new clientModule.Client(
            { name: 'stateless-client', version: '1.0.0' },
            { versionNegotiation: { mode: 'auto' }, capabilities: { elicitation: {} } }
          )
          client.setRequestHandler('elicitation/create', () => ({ action: 'accept', content: { ok: true } }))
          await client.connect(transport)
        })

        afterEach(async () => {
          await client.close()
          await handler.close()
        })

        it('negotiates the stateless protocol', () => {
          assert.equal(client.getProtocolEra(), 'modern')
        })

        it('traces a tool call with a request span and a tool span', async () => {
          const traceAssertion = agent.assertSomeTraces(traces => {
            const requestSpan = findSpan(traces, 'mcp.request', 'server_tool_call')
            const toolSpan = findSpan(traces, 'mcp.server.tool.call', 'test-tool')

            assert.ok(requestSpan)
            assert.ok(toolSpan)
            assert.equal(toolSpan.parent_id.toString(), requestSpan.span_id.toString())
          })

          await Promise.all([traceAssertion, client.callTool({ name: 'test-tool', arguments: {} })])
        })

        it('tags an input_required result without an error', async () => {
          const traceAssertion = agent.assertSomeTraces(traces => {
            const requestSpans = traces.flat().filter(span => {
              return span.name === 'mcp.request' && span.resource === 'server_tool_call'
            })
            const pending = requestSpans.find(span => span.metrics['mcp.input_required'] === 1)

            assert.ok(pending, 'the first leg should be tagged as input_required')
            assert.equal(pending.error, 0)
          })

          const [, result] = await Promise.all([
            traceAssertion,
            client.callTool({ name: 'confirm-tool', arguments: {} }),
          ])
          assert.equal(result.content[0].text, 'confirmed')
        })

        it('parents the server request span to the client span through _meta', async () => {
          // The client and server spans can arrive in separate payloads.
          const spans = []
          const traceAssertion = agent.assertSomeTraces(traces => {
            spans.push(...traces.flat())
            const clientSpans = spans.filter(span => span.resource === 'client_tool_call')
            const serverSpans = spans.filter(span => span.resource === 'server_tool_call')

            assert.ok(serverSpans.some(serverSpan => clientSpans.some(clientSpan => {
              return serverSpan.trace_id.toString() === clientSpan.trace_id.toString() &&
                serverSpan.parent_id.toString() === clientSpan.span_id.toString()
            })), 'a server request span should be a child of a client tool call span')
          })

          await Promise.all([
            traceAssertion,
            client.callTool({ name: 'test-tool', arguments: {} }),
          ])
        })
      })
    })
  })
})
