'use strict'

const assert = require('node:assert')
const { inspect } = require('node:util')
const { describe, it, before, beforeEach, after } = require('mocha')
const { withVersions } = require('../../../setup/mocha')

const agent = require('../../../plugins/agent')
const {
  assertLlmObsSpanEvent,
  MOCK_STRING,
  useLlmObs,
} = require('../../util')

describe('integrations', () => {
  let Client
  let McpServer
  let InMemoryTransport

  let client
  let server

  describe('modelcontextprotocol-sdk', () => {
    const { getEvents } = useLlmObs({ plugin: 'modelcontextprotocol-sdk' })

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

        // The MCP handshake (client.connect) triggers server-side request spans.
        // Drain them now so they do not bleed into the first test.
        // Flush interval is 0 — wait a few ticks for the writer to send them.
        for (let i = 0; i < 20; i++) {
          await new Promise(resolve => setImmediate(resolve))
        }
        agent.getLlmObsSpanEventsRequests(true)
      })

      after(async () => {
        if (client) await client.close()
        if (server) await server.close()
      })

      describe('Client.callTool', () => {
        // client.callTool produces 3 LLMObs spans per call:
        //   [0] client tool call  (starts first — initiated by the caller)
        //   [1] server request    (starts when server receives the message)
        //   [2] server tool call  (starts inside the server request handler)
        it('creates a tool span for a basic tool call', async () => {
          const result = await client.callTool({ name: 'test-tool', arguments: {} })

          assert.ok(result.content)
          assert.equal(result.content[0].text, 'Result from test-tool')

          const { apmSpans, llmobsSpans } = await getEvents(3)

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

          const { apmSpans, llmobsSpans } = await getEvents(3)

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

          const { apmSpans, llmobsSpans } = await getEvents(3)

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

          const { apmSpans, llmobsSpans } = await getEvents(3)

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'tool',
            name: 'MCP Client Tool Call: error-tool',
            inputValue: JSON.stringify({ name: 'error-tool', arguments: {} }),
            error: {
              type: MOCK_STRING,
              message: MOCK_STRING,
              stack: MOCK_STRING,
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
        // client.listTools produces 2 LLMObs spans per call:
        //   [0] client list tools  (starts first)
        //   [1] server request     (starts when server receives the message)
        it('creates a task span for listing tools', async () => {
          const result = await client.listTools()

          assert.ok(result.tools)
          assert.equal(result.tools.length, 3)

          const { apmSpans, llmobsSpans } = await getEvents(2)

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'task',
            name: 'MCP Client List Tools',
            outputValue: JSON.stringify(result),
            tags: { ml_app: 'test', integration: 'modelcontextprotocol-sdk' },
          })
        })
      })

      describe('McpServer (server-side)', () => {
        describe('McpServerRequestLLMObsPlugin', () => {
          it('creates a task span for a tools/call server request', async () => {
            await client.callTool({ name: 'test-tool', arguments: {} })

            const { apmSpans, llmobsSpans } = await getEvents(3)

            // llmobsSpans sorted by start_ns: [0]=client tool call, [1]=server request, [2]=server tool call
            // The server request LLMObs span is a child of the client tool call span (in-memory transport
            // executes synchronously in the same async context).
            assertLlmObsSpanEvent(llmobsSpans[1], {
              span: apmSpans[1],
              parentId: apmSpans[0].span_id,
              spanKind: 'task',
              name: 'MCP Server Request: tools/call',
              inputValue: JSON.stringify({ name: 'test-tool', arguments: {} }),
              tags: { ml_app: 'test', integration: 'modelcontextprotocol-sdk' },
            })
          })

          it('creates a task span for a tools/list server request', async () => {
            await client.listTools()

            const { apmSpans, llmobsSpans } = await getEvents(2)

            // llmobsSpans sorted by start_ns: [0]=client list tools, [1]=server request
            assertLlmObsSpanEvent(llmobsSpans[1], {
              span: apmSpans[1],
              parentId: apmSpans[0].span_id,
              spanKind: 'task',
              name: 'MCP Server Request: tools/list',
              tags: { ml_app: 'test', integration: 'modelcontextprotocol-sdk' },
            })
          })
        })

        describe('McpServerToolCallLLMObsPlugin', () => {
          it('creates a tool span for a server-side tool execution', async () => {
            await client.callTool({ name: 'test-tool', arguments: {} })

            const { apmSpans, llmobsSpans } = await getEvents(3)

            // llmobsSpans[2] is the server tool call span (starts last, inside the server request)
            // The server tool call LLMObs span is a child of the server request span.
            assertLlmObsSpanEvent(llmobsSpans[2], {
              span: apmSpans[2],
              parentId: apmSpans[1].span_id,
              spanKind: 'tool',
              name: 'MCP Server Tool Call: test-tool',
              inputValue: JSON.stringify({ name: 'test-tool', arguments: {} }),
              outputValue: JSON.stringify({
                content: [{ type: 'text', text: 'Result from test-tool', annotations: {}, meta: {} }],
                isError: false,
              }),
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_tool_kind: 'server',
              },
            })
          })

          it('creates a tool span for a server-side tool execution with arguments', async () => {
            await client.callTool({
              name: 'test-tool',
              arguments: { query: 'hello world', limit: 10 },
            })

            const { apmSpans, llmobsSpans } = await getEvents(3)

            // The MCP SDK validates tool arguments against the inputSchema before calling executeToolHandler.
            // test-tool is registered with inputSchema: {} (empty Zod object schema), which strips unknown
            // keys during validation, so the args passed to executeToolHandler are always {}.
            assertLlmObsSpanEvent(llmobsSpans[2], {
              span: apmSpans[2],
              parentId: apmSpans[1].span_id,
              spanKind: 'tool',
              name: 'MCP Server Tool Call: test-tool',
              inputValue: JSON.stringify({ name: 'test-tool', arguments: {} }),
              outputValue: JSON.stringify({
                content: [{ type: 'text', text: 'Result from test-tool', annotations: {}, meta: {} }],
                isError: false,
              }),
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_tool_kind: 'server',
              },
            })
          })

          it('creates a tool span with error for a server-side tool error', async () => {
            const result = await client.callTool({ name: 'error-tool', arguments: {} })
            assert.ok(result.isError)

            const { apmSpans, llmobsSpans } = await getEvents(3)

            assertLlmObsSpanEvent(llmobsSpans[2], {
              span: apmSpans[2],
              parentId: apmSpans[1].span_id,
              spanKind: 'tool',
              name: 'MCP Server Tool Call: error-tool',
              inputValue: JSON.stringify({ name: 'error-tool', arguments: {} }),
              error: {
                type: MOCK_STRING,
                message: MOCK_STRING,
                stack: MOCK_STRING,
              },
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_tool_kind: 'server',
              },
            })
          })
        })
      })
    })
  })
})
