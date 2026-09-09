'use strict'

const assert = require('node:assert')
const path = require('node:path')
const { inspect } = require('node:util')
const { describe, it, before, after } = require('mocha')
const { withVersions } = require('../../../setup/mocha')

const {
  assertLlmObsSpanEvent,
  MOCK_STRING,
  useLlmObs,
} = require('../../util')

/**
 * Connects an in-memory MCP client/server pair for the given SDK version.
 *
 * @param {string} version
 * @param {(server: object) => void} registerTools
 * @returns {Promise<{ client: object, server: object }>}
 */
async function connectClientAndServer (version, registerTools) {
  const versionModule = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)

  // Require the client submodule first so RITM patches it before the server loads it transitively
  const { Client } = versionModule.get('@modelcontextprotocol/sdk/client')

  // The package exports map remaps package.json to dist/cjs/package.json, so navigate
  // up from the resolved client entry path to find the SDK root directory
  const clientEntryPath = versionModule.getPath('@modelcontextprotocol/sdk/client')
  const sdkDir = path.resolve(path.dirname(clientEntryPath), '..', '..', '..')
  const { McpServer } = require(path.join(sdkDir, 'dist/cjs/server/mcp.js'))

  const { InMemoryTransport } = versionModule.get('@modelcontextprotocol/sdk/inMemory.js')

  const server = new McpServer({ name: 'test-server', version: '1.0.0' })
  registerTools(server)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)

  return { client, server }
}

describe('integrations', () => {
  let client
  let server

  describe('modelcontextprotocol-sdk', () => {
    const { getEvents } = useLlmObs({ plugin: 'modelcontextprotocol-sdk' })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', (version) => {
      before(async () => {
        ;({ client, server } = await connectClientAndServer(version, (mcpServer) => {
          mcpServer.registerTool(
            'test-tool',
            { description: 'A test tool', inputSchema: {} },
            async () => ({
              content: [{ type: 'text', text: 'Result from test-tool' }],
            })
          )

          mcpServer.registerTool(
            'error-tool',
            { description: 'A tool that errors', inputSchema: {} },
            async () => {
              throw new Error('Intentional test error')
            }
          )

          mcpServer.registerTool(
            'multi-content-tool',
            { description: 'Returns multiple content parts', inputSchema: {} },
            async () => ({
              content: [
                { type: 'text', text: 'First part' },
                { type: 'text', text: 'Second part' },
              ],
            })
          )
        }))
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
        it('creates a task span for listing tools', async () => {
          const result = await client.listTools()

          assert.ok(result.tools)
          assert.equal(result.tools.length, 3)

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'task',
            name: 'MCP Client List Tools',
            outputValue: JSON.stringify(result),
            tags: { ml_app: 'test', integration: 'modelcontextprotocol-sdk' },
          })
        })
      })
    })
  })

  describe('modelcontextprotocol-sdk with llmobs disabled', () => {
    const { assertNoLlmObsSpans } = useLlmObs({
      plugin: 'modelcontextprotocol-sdk',
      pluginConfig: { llmobs: false },
    })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', (version) => {
      let disabledClient
      let disabledServer

      before(async () => {
        ({ client: disabledClient, server: disabledServer } = await connectClientAndServer(version, (mcpServer) => {
          mcpServer.registerTool(
            'test-tool',
            { description: 'A test tool', inputSchema: {} },
            async () => ({
              content: [{ type: 'text', text: 'Result from test-tool' }],
            })
          )
        }))
      })

      after(async () => {
        if (disabledClient) await disabledClient.close()
        if (disabledServer) await disabledServer.close()
      })

      it('does not create an LLMObs span for Client.callTool', async () => {
        const result = await disabledClient.callTool({ name: 'test-tool', arguments: {} })
        assert.equal(result.content[0].text, 'Result from test-tool')

        // assertNoLlmObsSpans awaits the APM traces first, so this also pins that APM
        // tracing for the integration survives the LLM Obs opt-out.
        await assertNoLlmObsSpans()
      })

      it('does not create an LLMObs span for Client.listTools', async () => {
        const result = await disabledClient.listTools()
        assert.equal(result.tools.length, 1)
        assert.equal(result.tools[0].name, 'test-tool')

        await assertNoLlmObsSpans()
      })
    })
  })
})
