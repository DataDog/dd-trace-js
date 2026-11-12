'use strict'

const assert = require('node:assert/strict')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')

describe('Plugin', () => {
  describe('modelcontextprotocol-sdk with @modelcontextprotocol/client 2.x', () => {
    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/client', '>=2', version => {
      let tracer
      let clientModule
      let serverModule

      before(async () => {
        await agent.load('modelcontextprotocol-sdk')
        tracer = require('../../dd-trace')
        clientModule = require(`../../../versions/@modelcontextprotocol/client@${version}`).get()
        serverModule = require('../../../versions/@modelcontextprotocol/server@2').get()
      })

      after(() => agent.close({ ritmReset: false }))

      function createServer () {
        const server = new serverModule.McpServer({ name: 'test-server', version: '1.0.0' })
        server.registerTool('test-tool', { description: 'A test tool', inputSchema: {} }, async () => ({
          content: [{ type: 'text', text: 'Result from test-tool' }],
        }))
        server.registerTool('error-tool', { description: 'A failing tool', inputSchema: {} }, async () => {
          throw new Error('Intentional test error')
        })
        server.registerResource('test-resource', 'file:///test.txt', { mimeType: 'text/plain' }, async () => ({
          contents: [{ uri: 'file:///test.txt', text: 'resource content' }],
        }))
        server.registerPrompt('test-prompt', { description: 'A test prompt' }, async () => ({
          messages: [{ role: 'user', content: { type: 'text', text: 'prompt message' } }],
        }))
        return server
      }

      describe('stateful', () => {
        let server
        let client

        beforeEach(async () => {
          server = createServer()
          const [clientTransport, serverTransport] = clientModule.InMemoryTransport.createLinkedPair()
          await server.connect(serverTransport)
          client = new clientModule.Client({ name: 'test-client', version: '1.0.0' })
          await client.connect(clientTransport)
        })

        afterEach(async () => {
          await client.close()
          await server.close()
        })

        const cases = [
          {
            method: 'callTool',
            call: client => client.callTool({ name: 'test-tool', arguments: {} }),
            span: { name: 'mcp.request', resource: 'client_tool_call', component: 'modelcontextprotocol_client' },
          },
          {
            method: 'listTools',
            call: client => client.listTools(),
            span: {
              name: 'mcp.request',
              resource: 'ClientSession.list_tools',
              component: 'modelcontextprotocol_list_tools',
            },
          },
          {
            method: 'listResources',
            call: client => client.listResources(),
            span: {
              name: 'mcp.resources.list',
              resource: 'resources/list',
              component: 'modelcontextprotocol_list_resources',
            },
          },
          {
            method: 'readResource',
            call: client => client.readResource({ uri: 'file:///test.txt' }),
            span: {
              name: 'mcp.resource.read',
              resource: 'resources/read',
              component: 'modelcontextprotocol_read_resource',
            },
          },
          {
            method: 'listPrompts',
            call: client => client.listPrompts(),
            span: {
              name: 'mcp.prompts.list',
              resource: 'prompts/list',
              component: 'modelcontextprotocol_list_prompts',
            },
          },
          {
            method: 'getPrompt',
            call: client => client.getPrompt({ name: 'test-prompt' }),
            span: { name: 'mcp.prompt.get', resource: 'prompts/get', component: 'modelcontextprotocol_get_prompt' },
          },
        ]

        for (const { method, call, span } of cases) {
          it(`traces Client.${method}`, async () => {
            const traceAssertion = expectSomeSpan(agent, {
              name: span.name,
              type: 'mcp',
              resource: span.resource,
              error: 0,
              meta: { component: span.component, '_dd.integration': span.component, 'span.kind': 'client' },
            })

            await call(client)

            return traceAssertion
          })
        }

        it('tags an isError tool result as an error', async () => {
          const traceAssertion = expectSomeSpan(agent, {
            name: 'mcp.request',
            resource: 'client_tool_call',
            error: 1,
            meta: { component: 'modelcontextprotocol_client', 'error.message': 'Intentional test error' },
          })

          const result = await client.callTool({ name: 'error-tool', arguments: {} })
          assert.equal(result.isError, true)

          return traceAssertion
        })
      })

      describe('stateless', () => {
        let handler
        let client

        beforeEach(async () => {
          handler = serverModule.createMcpHandler(createServer)
          // Clear the active span so the server span can only get its parent from `_meta`.
          const transport = new clientModule.StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
            fetch: (url, init) => tracer.scope().activate(null, () => handler.fetch(new Request(url, init))),
          })
          client = new clientModule.Client(
            { name: 'stateless-client', version: '1.0.0' },
            { versionNegotiation: { mode: 'auto' } }
          )
          await client.connect(transport)
        })

        afterEach(async () => {
          await client.close()
          await handler.close()
        })

        it('negotiates the stateless protocol', () => {
          assert.equal(client.getProtocolEra(), 'modern')
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

          await client.callTool({ name: 'test-tool', arguments: {} })

          return traceAssertion
        })
      })
    })
  })
})
