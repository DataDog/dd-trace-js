'use strict'

const assert = require('node:assert')
const { inspect } = require('node:util')
const { describe, it, before, after } = require('mocha')
const { withVersions } = require('../../../setup/mocha')

const {
  assertLlmObsSpanEvent,
  MOCK_STRING,
  useLlmObs,
} = require('../../util')

describe('integrations', () => {
  let Client
  let McpServer
  let InMemoryTransport
  let tool
  let loadMcpTools
  let tracer

  let client
  let server

  describe('modelcontextprotocol-sdk', () => {
    const { getEvents } = useLlmObs({ plugin: ['langchain', 'modelcontextprotocol-sdk'] })

    before(() => {
      tracer = global._ddtrace
    })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', (version) => {
      before(async () => {
        const path = require('path')
        const versionModule = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)

        // Require the client submodule first so RITM patches it before the server loads it transitively
        Client = versionModule.get('@modelcontextprotocol/sdk/client').Client

        // The package exports map remaps package.json to dist/cjs/package.json, so navigate
        // up from the resolved client entry path to find the SDK root directory
        const clientEntryPath = versionModule.getPath('@modelcontextprotocol/sdk/client')
        const sdkDir = path.resolve(path.dirname(clientEntryPath), '..', '..', '..')
        McpServer = require(path.join(sdkDir, 'dist/cjs/server/mcp.js')).McpServer

        InMemoryTransport = versionModule.get('@modelcontextprotocol/sdk/inMemory.js').InMemoryTransport
        tool = require('../../../../../../versions/@langchain/core@1').get('@langchain/core/tools').tool
        loadMcpTools = require('../../../../../../versions/@langchain/mcp-adapters@1.1.3').get().loadMcpTools

        server = new McpServer({ name: 'test-server', version: '1.0.0' })

        server.registerTool(
          'test-tool',
          { description: 'A test tool', inputSchema: {} },
          async () => ({
            content: [{ type: 'text', text: 'Result from test-tool' }],
          })
        )

        server.registerTool(
          'error-tool',
          { description: 'A tool that errors', inputSchema: {} },
          async () => {
            throw new Error('Intentional test error')
          }
        )

        server.registerTool(
          'multi-content-tool',
          { description: 'Returns multiple content parts', inputSchema: {} },
          async () => ({
            content: [
              { type: 'text', text: 'First part' },
              { type: 'text', text: 'Second part' },
            ],
          })
        )

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
            name: 'MCP Client Tool Call: test-tool',
            inputValue: JSON.stringify({ name: 'test-tool', arguments: {} }),
            outputValue: JSON.stringify({
              content: [{ type: 'text', text: 'Result from test-tool', annotations: {}, meta: {} }],
              isError: false,
            }),
            tags: {
              ml_app: 'test',
              integration: 'modelcontextprotocol-sdk',
              mcp_tool_kind: 'client',
              mcp_server_name: 'test-server',
              mcp_server_version: '1.0.0',
            },
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
            name: 'MCP Client Tool Call: test-tool',
            inputValue: JSON.stringify({
              name: 'test-tool',
              arguments: { query: 'hello world', limit: 10 },
            }),
            outputValue: JSON.stringify({
              content: [{ type: 'text', text: 'Result from test-tool', annotations: {}, meta: {} }],
              isError: false,
            }),
            tags: {
              ml_app: 'test',
              integration: 'modelcontextprotocol-sdk',
              mcp_tool_kind: 'client',
              mcp_server_name: 'test-server',
              mcp_server_version: '1.0.0',
            },
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
            name: 'MCP Client Tool Call: multi-content-tool',
            inputValue: JSON.stringify({ name: 'multi-content-tool', arguments: {} }),
            outputValue: JSON.stringify({
              content: [
                { type: 'text', text: 'First part', annotations: {}, meta: {} },
                { type: 'text', text: 'Second part', annotations: {}, meta: {} },
              ],
              isError: false,
            }),
            tags: {
              ml_app: 'test',
              integration: 'modelcontextprotocol-sdk',
              mcp_tool_kind: 'client',
              mcp_server_name: 'test-server',
              mcp_server_version: '1.0.0',
            },
          })
        })

        it('creates a tool span with error on failure', async () => {
          // In MCP SDK 1.27+, tool errors are returned as isError:true results, not thrown exceptions
          const result = await client.callTool({ name: 'error-tool', arguments: {} })
          assert.ok(result.isError, 'callTool result should have isError: true')
          assert.ok(
            result.content?.[0]?.text?.includes('Intentional test error'),
            `Got: ${inspect(result.content?.[0]?.text)}`
          )

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'tool',
            name: 'MCP Client Tool Call: error-tool',
            inputValue: JSON.stringify({ name: 'error-tool', arguments: {} }),
            error: {
              type: MOCK_STRING,
              message: MOCK_STRING,
            },
            tags: {
              ml_app: 'test',
              integration: 'modelcontextprotocol-sdk',
              mcp_tool_kind: 'client',
              mcp_server_name: 'test-server',
              mcp_server_version: '1.0.0',
            },
          })
        })
      })

      describe('Client.listTools', () => {
        it('captures the tool inventory', async () => {
          const result = await client.listTools()

          assert.ok(result.tools)
          assert.equal(result.tools.length, 3)

          const { apmSpans, llmobsSpans } = await getEvents()
          const listToolsSpan = apmSpans.find(span => span.resource === 'ClientSession.list_tools')
          assert.ok(listToolsSpan, 'MCP list-tools APM span should remain present')

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: listToolsSpan,
            spanKind: 'task',
            name: 'MCP Client List Tools',
            outputValue: JSON.stringify(result),
            tags: { ml_app: 'test', integration: 'modelcontextprotocol-sdk' },
          })
        })

        it('captures the tool inventory once per trace', async () => {
          await tracer.trace('list-tools', async () => {
            await client.listTools()
            await client.listTools()
          })

          const { apmSpans, llmobsSpans } = await getEvents()
          const listToolsSpans = apmSpans.filter(span => span.resource === 'ClientSession.list_tools')
          assert.equal(listToolsSpans.length, 2)
          assert.equal(llmobsSpans.length, 1)
        })

        it('captures the tool inventory once for concurrent calls in a trace', async () => {
          await tracer.trace('list-tools', () => Promise.all([client.listTools(), client.listTools()]))

          const { apmSpans, llmobsSpans } = await getEvents()
          const listToolsSpans = apmSpans.filter(span => span.resource === 'ClientSession.list_tools')
          assert.equal(listToolsSpans.length, 2)
          assert.equal(llmobsSpans.length, 1)
        })

        it('captures the tool inventory after a dropped event in the same trace', async () => {
          let processorCalls = 0
          tracer.llmobs.registerProcessor(span => ++processorCalls === 1 ? null : span)

          try {
            await tracer.trace('list-tools', async () => {
              await client.listTools()
              await client.listTools()
            })
          } finally {
            tracer.llmobs.deregisterProcessor()
          }

          const { apmSpans, llmobsSpans } = await getEvents()
          const listToolsSpans = apmSpans.filter(span => span.resource === 'ClientSession.list_tools')
          assert.equal(listToolsSpans.length, 2)
          assert.equal(llmobsSpans.length, 1)
        })
      })

      describe('LangChain MCP adapter', () => {
        it('keeps the LangChain tool as the only payload-bearing LLMObs tool span', async () => {
          const [tool] = await loadMcpTools('test-server', client)
          const { llmobsSpans: discoveryLlmObsSpans } = await getEvents()
          assert.equal(discoveryLlmObsSpans.length, 1)
          assert.equal(discoveryLlmObsSpans[0].name, 'MCP Client List Tools')

          const result = await tool.invoke({})

          assert.equal(result, 'Result from test-tool')

          const { apmSpans, llmobsSpans } = await getEvents(1)
          assert.equal(llmobsSpans.length, 1)
          const langchainSpan = apmSpans.find(span => span.span_id.toString() === llmobsSpans[0].span_id)
          assert.ok(langchainSpan, 'LangChain LLMObs span should have a matching APM span')

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: langchainSpan,
            spanKind: 'tool',
            name: 'test-tool',
            inputValue: JSON.stringify({}),
            outputValue: 'Result from test-tool',
            tags: { ml_app: 'test', integration: 'langchain' },
          })
        })

        it('keeps MCP spans for custom LangChain tools', async () => {
          const customTool = tool(
            () => client.callTool({ name: 'test-tool', arguments: {} }),
            {
              name: 'custom-mcp-tool',
              description: 'Calls an MCP tool',
              schema: {},
            }
          )

          await customTool.invoke({})

          const { llmobsSpans } = await getEvents(2)
          assert.equal(llmobsSpans.length, 2)
          assert.ok(llmobsSpans.some(span => span.name === 'custom-mcp-tool'))
          assert.ok(llmobsSpans.some(span => span.name === 'MCP Client Tool Call: test-tool'))
        })
      })
    })
  })
})
