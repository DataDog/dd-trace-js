'use strict'

const assert = require('node:assert')
const { describe, it, before, after } = require('mocha')
const { withVersions } = require('../../../setup/mocha')

const {
  assertLlmObsSpanEvent,
  MOCK_STRING,
  useLlmObs,
} = require('../../util')

describe('integrations', () => {
  let Client
  let Server
  let InMemoryTransport
  let CallToolRequestSchema
  let ListToolsRequestSchema

  let client
  let server

  describe('modelcontextprotocol-sdk', () => {
    const { getEvents } = useLlmObs({ plugin: 'modelcontextprotocol-sdk' })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', (version) => {
      before(async () => {
        // Require the client submodule first so RITM patches it before the server loads it transitively
        Client = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
          .get('@modelcontextprotocol/sdk/client').Client

        Server = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
          .get('@modelcontextprotocol/sdk/server').Server

        InMemoryTransport = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
          .get('@modelcontextprotocol/sdk/inMemory.js').InMemoryTransport

        const typesMod = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
          .get('@modelcontextprotocol/sdk/types.js')
        CallToolRequestSchema = typesMod.CallToolRequestSchema
        ListToolsRequestSchema = typesMod.ListToolsRequestSchema

        // Set up mock MCP server
        server = new Server(
          { name: 'test-server', version: '1.0.0' },
          { capabilities: { tools: {} } }
        )

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const toolName = request.params.name
          if (toolName === 'error-tool') {
            throw new Error('Intentional test error')
          }
          if (toolName === 'multi-content-tool') {
            return {
              content: [
                { type: 'text', text: 'First part' },
                { type: 'text', text: 'Second part' },
              ],
            }
          }
          return {
            content: [{ type: 'text', text: `Result from ${toolName}` }],
          }
        })

        server.setRequestHandler(ListToolsRequestSchema, async () => {
          return {
            tools: [
              { name: 'test-tool', description: 'A test tool', inputSchema: { type: 'object' } },
              { name: 'error-tool', description: 'A tool that errors', inputSchema: { type: 'object' } },
              {
                name: 'multi-content-tool',
                description: 'Returns multiple content parts',
                inputSchema: { type: 'object' },
              },
            ],
          }
        })

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)

        client = new Client({ name: 'test-client', version: '1.0.0' })
        await client.connect(clientTransport)
      })

      after(async () => {
        if (client) await client.close()
        if (server) await server.close()
      })

      describe('Client.callTool', () => {
        it('creates a tool span for a basic tool call', async () => {
          const result = await client.callTool({ name: 'test-tool', arguments: {} })

          assert.ok(result.content)
          assert.equal(result.content[0].text, 'Result from test-tool')

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'tool',
            name: 'mcp.tool.test-tool',
            inputValue: JSON.stringify({ name: 'test-tool', arguments: {} }),
            outputValue: 'Result from test-tool',
            metadata: {
              'mcp.tool.name': 'test-tool',
              'mcp.server.name': 'test-server',
            },
            tags: { ml_app: 'test', integration: 'modelcontextprotocol-sdk' },
          })
        })

        it('creates a tool span with arguments', async () => {
          const result = await client.callTool({
            name: 'test-tool',
            arguments: { query: 'hello world', limit: 10 },
          })

          assert.ok(result.content)

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'tool',
            name: 'mcp.tool.test-tool',
            inputValue: JSON.stringify({
              name: 'test-tool',
              arguments: { query: 'hello world', limit: 10 },
            }),
            outputValue: 'Result from test-tool',
            metadata: {
              'mcp.tool.name': 'test-tool',
              'mcp.server.name': 'test-server',
            },
            tags: { ml_app: 'test', integration: 'modelcontextprotocol-sdk' },
          })
        })

        it('creates a tool span with multi-content response', async () => {
          const result = await client.callTool({ name: 'multi-content-tool', arguments: {} })

          assert.ok(result.content)
          assert.equal(result.content.length, 2)

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'tool',
            name: 'mcp.tool.multi-content-tool',
            inputValue: JSON.stringify({ name: 'multi-content-tool', arguments: {} }),
            outputValue: 'First part\nSecond part',
            metadata: {
              'mcp.tool.name': 'multi-content-tool',
              'mcp.server.name': 'test-server',
            },
            tags: { ml_app: 'test', integration: 'modelcontextprotocol-sdk' },
          })
        })

        it('creates a tool span with error on failure', async () => {
          try {
            await client.callTool({ name: 'error-tool', arguments: {} })
            assert.fail('Expected error to be thrown')
          } catch (err) {
            assert.ok(err.message.includes('Intentional test error'))
          }

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'tool',
            name: 'mcp.tool.error-tool',
            inputValue: JSON.stringify({ name: 'error-tool', arguments: {} }),
            error: {
              type: MOCK_STRING,
              message: MOCK_STRING,
              stack: MOCK_STRING,
            },
            metadata: {
              'mcp.tool.name': 'error-tool',
              'mcp.server.name': 'test-server',
            },
            tags: { ml_app: 'test', integration: 'modelcontextprotocol-sdk' },
          })
        })
      })
    })
  })
})
