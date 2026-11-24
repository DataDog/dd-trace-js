'use strict'

const { describe, it, before, beforeEach, afterEach } = require('mocha')

const { withVersions } = require('../../../setup/mocha')
const { assertLlmObsSpanEvent, MOCK_STRING, useLlmObs } = require('../../util')

const BASE_TAGS = { ml_app: 'test', integration: 'modelcontextprotocol-sdk' }
const TOOL_RESULT = { content: [{ type: 'text', text: 'Result from test-tool' }] }

/**
 * The 2.x client is traced too, so each request also has a client span, which is the parent of the server span.
 *
 * @param {{ apmSpans: Array<{ resource: string }>, llmobsSpans: Array<{ name: string, span_id: string }> }} events
 * @param {string} serverName
 * @param {string} serverResource
 * @param {string} clientName
 */
function findServerSpan ({ apmSpans, llmobsSpans }, serverName, serverResource, clientName) {
  return {
    llmobsSpan: llmobsSpans.find(span => span.name === serverName),
    apmSpan: apmSpans.find(span => span.resource === serverResource),
    parentId: llmobsSpans.find(span => span.name === clientName).span_id,
  }
}

describe('integrations', () => {
  describe('modelcontextprotocol-sdk with @modelcontextprotocol/server 2.x', () => {
    const { getEvents } = useLlmObs({ plugin: 'modelcontextprotocol-sdk' })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/server', '>=2', version => {
      let serverModule
      let clientModule

      before(() => {
        serverModule = require(`../../../../../../versions/@modelcontextprotocol/server@${version}`).get()
        clientModule = require('../../../../../../versions/@modelcontextprotocol/client@2').get()
      })

      function createServer () {
        const server = new serverModule.McpServer({ name: 'test-server', version: '1.0.0' })
        server.registerTool('test-tool', { description: 'A test tool', inputSchema: {} }, async () => TOOL_RESULT)
        return server
      }

      describe('stateful', () => {
        let server
        let client

        beforeEach(async () => {
          server = createServer()
          const [clientTransport, serverTransport] = serverModule.InMemoryTransport.createLinkedPair()
          await server.connect(serverTransport)
          client = new clientModule.Client({ name: 'test-client', title: 'Test Client', version: '2.0.0' })
          await client.connect(clientTransport)
        })

        afterEach(async () => {
          await client.close()
          await server.close()
        })

        it('creates a server tool span for tools/call', async () => {
          await client.callTool({ name: 'test-tool', arguments: { query: 'hello' } })

          const { llmobsSpan, apmSpan, parentId } = findServerSpan(
            await getEvents(2), 'test-tool', 'server_tool_call', 'MCP Client Tool Call: test-tool'
          )

          assertLlmObsSpanEvent(llmobsSpan, {
            span: apmSpan,
            parentId,
            spanKind: 'tool',
            name: 'test-tool',
            inputValue: JSON.stringify({
              method: 'tools/call',
              params: { name: 'test-tool', arguments: { query: 'hello' } },
              jsonrpc: '2.0',
              id: 1,
            }),
            outputValue: JSON.stringify(TOOL_RESULT),
            tags: {
              ...BASE_TAGS,
              mcp_method: 'tools/call',
              mcp_tool: 'test-tool',
              mcp_tool_kind: 'server',
              mcp_client_name: 'test-client',
              mcp_client_title: 'Test Client',
              mcp_client_version: '2.0.0',
            },
          })
        })

        it('creates a task span for other methods', async () => {
          await client.listTools()

          const { llmobsSpan, apmSpan, parentId } = findServerSpan(
            await getEvents(2), 'mcp.tools/list', 'tools/list', 'MCP Client List Tools'
          )

          assertLlmObsSpanEvent(llmobsSpan, {
            span: apmSpan,
            parentId,
            spanKind: 'task',
            name: 'mcp.tools/list',
            inputValue: JSON.stringify({ method: 'tools/list', jsonrpc: '2.0', id: 1 }),
            outputValue: MOCK_STRING,
            tags: {
              ...BASE_TAGS,
              mcp_method: 'tools/list',
              mcp_client_name: 'test-client',
              mcp_client_title: 'Test Client',
              mcp_client_version: '2.0.0',
            },
          })
        })
      })

      describe('stateless', () => {
        let handler
        let client

        beforeEach(async () => {
          handler = serverModule.createMcpHandler(createServer)
          const transport = new clientModule.StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
            fetch: (url, init) => handler.fetch(new Request(url, init)),
          })
          client = new clientModule.Client(
            { name: 'stateless-client', version: '3.0.0' },
            { versionNegotiation: { mode: 'auto' } }
          )
          await client.connect(transport)
        })

        afterEach(async () => {
          await client.close()
          await handler.close()
        })

        it('tags the envelope client info and keeps the reserved _meta keys in the input', async () => {
          await client.callTool({ name: 'test-tool', arguments: {}, _meta: { _dd_trace_context: {}, keep: 'me' } })

          const { llmobsSpan, apmSpan, parentId } = findServerSpan(
            await getEvents(2), 'test-tool', 'server_tool_call', 'MCP Client Tool Call: test-tool'
          )

          assertLlmObsSpanEvent(llmobsSpan, {
            span: apmSpan,
            parentId,
            spanKind: 'tool',
            name: 'test-tool',
            inputValue: JSON.stringify({
              method: 'tools/call',
              params: {
                name: 'test-tool',
                arguments: {},
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                  'io.modelcontextprotocol/clientInfo': { name: 'stateless-client', version: '3.0.0' },
                  'io.modelcontextprotocol/clientCapabilities': {},
                  keep: 'me',
                },
              },
              jsonrpc: '2.0',
              id: 0,
            }),
            outputValue: JSON.stringify(TOOL_RESULT),
            tags: {
              ...BASE_TAGS,
              mcp_method: 'tools/call',
              mcp_tool: 'test-tool',
              mcp_tool_kind: 'server',
              mcp_client_name: 'stateless-client',
              mcp_client_version: '3.0.0',
            },
          })
        })
      })
    })
  })
})
