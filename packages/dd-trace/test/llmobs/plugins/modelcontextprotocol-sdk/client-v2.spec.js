'use strict'

const { describe, it, before, beforeEach, afterEach } = require('mocha')

const { withVersions } = require('../../../setup/mocha')
const { assertLlmObsSpanEvent, MOCK_STRING, useLlmObs } = require('../../util')

const BASE_TAGS = { ml_app: 'test', integration: 'modelcontextprotocol-sdk' }
const SERVER_TAGS = { mcp_server_name: 'test-server', mcp_server_version: '1.0.0' }

describe('integrations', () => {
  describe('modelcontextprotocol-sdk with @modelcontextprotocol/client 2.x', () => {
    const { getEvents } = useLlmObs({ plugin: 'modelcontextprotocol-sdk' })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/client', '>=2', version => {
      let clientModule
      let serverModule
      let server
      let client

      before(() => {
        clientModule = require(`../../../../../../versions/@modelcontextprotocol/client@${version}`).get()
        serverModule = require('../../../../../../versions/@modelcontextprotocol/server@2').get()
      })

      beforeEach(async () => {
        server = new serverModule.McpServer({ name: 'test-server', version: '1.0.0' })
        server.registerTool('test-tool', { description: 'A test tool', inputSchema: {} }, async () => ({
          content: [{ type: 'text', text: 'Result from test-tool' }],
        }))
        server.registerTool('error-tool', { description: 'A failing tool', inputSchema: {} }, async () => ({
          content: [{ type: 'text', text: 'Intentional tool error' }],
          isError: true,
        }))
        const [clientTransport, serverTransport] = clientModule.InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        client = new clientModule.Client({ name: 'test-client', version: '1.0.0' })
        await client.connect(clientTransport)
      })

      afterEach(async () => {
        await client.close()
        await server.close()
      })

      it('creates a client tool span for Client.callTool', async () => {
        await client.callTool({ name: 'test-tool', arguments: { query: 'hello' } })

        const { apmSpans, llmobsSpans } = await getEvents(2)
        const clientSpan = llmobsSpans.find(span => span.name === 'MCP Client Tool Call: test-tool')

        assertLlmObsSpanEvent(clientSpan, {
          span: apmSpans.find(span => span.resource === 'client_tool_call'),
          spanKind: 'tool',
          name: 'MCP Client Tool Call: test-tool',
          inputValue: JSON.stringify({ name: 'test-tool', arguments: { query: 'hello' } }),
          outputValue: JSON.stringify({
            content: [{ type: 'text', text: 'Result from test-tool', annotations: {}, meta: {} }],
            isError: false,
          }),
          tags: { ...BASE_TAGS, ...SERVER_TAGS, mcp_tool_kind: 'client' },
        })
      })

      it('marks the client tool span as an error for an isError result', async () => {
        await client.callTool({ name: 'error-tool', arguments: {} })

        const { apmSpans, llmobsSpans } = await getEvents(2)
        const clientSpan = llmobsSpans.find(span => span.name === 'MCP Client Tool Call: error-tool')

        assertLlmObsSpanEvent(clientSpan, {
          span: apmSpans.find(span => span.resource === 'client_tool_call'),
          spanKind: 'tool',
          name: 'MCP Client Tool Call: error-tool',
          inputValue: JSON.stringify({ name: 'error-tool', arguments: {} }),
          error: { type: MOCK_STRING, message: 'Intentional tool error', stack: MOCK_STRING },
          tags: { ...BASE_TAGS, ...SERVER_TAGS, mcp_tool_kind: 'client' },
        })
      })

      it('creates a client task span for Client.listTools', async () => {
        const result = await client.listTools()

        const { apmSpans, llmobsSpans } = await getEvents(2)
        const clientSpan = llmobsSpans.find(span => span.name === 'MCP Client List Tools')

        assertLlmObsSpanEvent(clientSpan, {
          span: apmSpans.find(span => span.resource === 'ClientSession.list_tools'),
          spanKind: 'task',
          name: 'MCP Client List Tools',
          outputValue: JSON.stringify(result),
          tags: BASE_TAGS,
        })
      })

      it('keeps tracing Client.listTools after a result that cannot be serialized', async () => {
        // The SDK does not validate `_meta`, so a server can return one nested deeper than JSON.stringify supports.
        const nested = JSON.parse('['.repeat(10_000) + ']'.repeat(10_000))
        const [clientTransport, serverTransport] = clientModule.InMemoryTransport.createLinkedPair()
        let listCalls = 0
        serverTransport.onmessage = message => {
          if (message.id === undefined) return
          const result = message.method === 'initialize'
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'deep-server', version: '1.0.0' },
              }
            : { tools: [], ...(listCalls++ === 0 && { _meta: { nested } }) }
          serverTransport.send({ jsonrpc: '2.0', id: message.id, result })
        }
        await serverTransport.start()
        const deepClient = new clientModule.Client({ name: 'test-client', version: '1.0.0' })
        await deepClient.connect(clientTransport)

        try {
          await deepClient.listTools()
          const { apmSpans: deepApmSpans, llmobsSpans: deepSpans } = await getEvents()
          assertLlmObsSpanEvent(deepSpans[0], {
            span: deepApmSpans[0],
            spanKind: 'task',
            name: 'MCP Client List Tools',
            tags: BASE_TAGS,
          })

          const result = await deepClient.listTools()
          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'task',
            name: 'MCP Client List Tools',
            outputValue: JSON.stringify(result),
            tags: BASE_TAGS,
          })
        } finally {
          await deepClient.close()
        }
      })
    })
  })
})
