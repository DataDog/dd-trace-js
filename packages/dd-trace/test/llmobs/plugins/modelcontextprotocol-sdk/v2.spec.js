'use strict'

const assert = require('node:assert/strict')

const { after, before, describe, it } = require('mocha')

const { withVersions } = require('../../../setup/mocha')
const { assertLlmObsSpanEvent, MOCK_STRING, useLlmObs } = require('../../util')

// `clientInfo` is false where the request reaches a server instance that never saw the client's initialize request.
const SETUPS = [
  { name: 'in-memory transport', transport: 'memory', era: 'legacy', clientInfo: true },
  { name: 'stateful HTTP', transport: 'stateful', era: 'legacy', clientInfo: true, sessionId: 'test-session' },
  { name: 'stateless HTTP, 2025-11-25 protocol', transport: 'http', mode: 'legacy', era: 'legacy', clientInfo: false },
  { name: 'stateless HTTP, 2026-07-28 protocol', transport: 'http', mode: 'auto', era: 'modern', clientInfo: true },
]

const TAGS = {
  ml_app: 'test',
  integration: 'modelcontextprotocol-sdk',
}

const CLIENT_INFO = { name: 'test-client', title: 'Test Client', version: '1.0.0' }

/**
 * @param {{ clientInfo: boolean, sessionId?: string }} setup
 * @param {string} tool
 */
function serverTags (setup, tool) {
  return {
    ...TAGS,
    mcp_method: 'tools/call',
    mcp_tool: tool,
    mcp_tool_kind: 'server',
    ...(setup.sessionId && { mcp_session_id: setup.sessionId }),
    ...(setup.clientInfo && {
      mcp_client_name: CLIENT_INFO.name,
      mcp_client_title: CLIENT_INFO.title,
      mcp_client_version: CLIENT_INFO.version,
    }),
  }
}

describe('integrations', () => {
  describe('modelcontextprotocol-sdk with SDK 2.x', () => {
    const { getEvents } = useLlmObs({ plugin: 'modelcontextprotocol-sdk' })

    // Each 2.x package folder also installs the latest release of the other package.
    withVersions('modelcontextprotocol-sdk', ['@modelcontextprotocol/client', '@modelcontextprotocol/server'], (
      version, moduleName
    ) => {
      for (const setup of SETUPS) {
        describe(setup.name, () => {
          let client
          let closeServer

          before(async () => {
            const versionMod = require(`../../../../../../versions/${moduleName}@${version}`)
            const { Client, StreamableHTTPClientTransport } = versionMod.get('@modelcontextprotocol/client')
            const {
              createMcpHandler,
              InMemoryTransport,
              McpServer,
              WebStandardStreamableHTTPServerTransport,
            } = versionMod.get('@modelcontextprotocol/server')

            const createServer = () => {
              const server = new McpServer({ name: 'test-server', version: '1.0.0' })
              server.registerTool('echo', { description: 'Echoes a fixed text' }, async () => ({
                content: [{ type: 'text', text: 'echo result' }],
              }))
              server.registerTool('error-tool', { description: 'Returns an error result' }, async () => ({
                content: [{ type: 'text', text: 'Intentional tool error' }],
                isError: true,
              }))
              return server
            }

            let transport
            if (setup.transport === 'memory') {
              const server = createServer()
              const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
              await server.connect(serverTransport)
              transport = clientTransport
              closeServer = () => server.close()
            } else if (setup.transport === 'stateful') {
              const server = createServer()
              const serverTransport = new WebStandardStreamableHTTPServerTransport({
                sessionIdGenerator: () => setup.sessionId,
              })
              await server.connect(serverTransport)
              transport = new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
                fetch: (url, init) => serverTransport.handleRequest(new Request(url, init)),
              })
              closeServer = () => server.close()
            } else {
              const handler = createMcpHandler(createServer)
              transport = new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
                fetch: (url, init) => handler.fetch(new Request(url, init)),
              })
              closeServer = () => handler.close()
            }

            const clientOptions = setup.mode && { versionNegotiation: { mode: setup.mode } }
            client = new Client(CLIENT_INFO, clientOptions)
            await client.connect(transport)
            assert.equal(client.getProtocolEra(), setup.era)
          })

          after(async () => {
            await client?.close()
            await closeServer?.()
          })

          it('creates client and server tool spans for a tool call', async () => {
            // The server input keeps the caller's own `_meta` keys and drops the SDK's reserved ones
            const result = await client.callTool({
              name: 'echo',
              arguments: { text: 'hi' },
              _meta: { requestTag: 'abc' },
            })
            assert.equal(result.content[0].text, 'echo result')

            const { apmSpans, llmobsSpans } = await getEvents(2)
            const clientApmSpan = apmSpans.find(span => span.resource === 'client_tool_call')
            const serverApmSpan = apmSpans.find(span => span.resource === 'server_tool_call')
            const clientSpan = llmobsSpans.find(span => span.name === 'MCP Client Tool Call: echo')
            const serverSpan = llmobsSpans.find(span => span.name === 'echo')
            // The JSON-RPC id depends on how many requests the connection sent before
            const { id } = JSON.parse(serverSpan.meta.input.value)

            assertLlmObsSpanEvent(clientSpan, {
              span: clientApmSpan,
              spanKind: 'tool',
              name: 'MCP Client Tool Call: echo',
              inputValue: JSON.stringify({ name: 'echo', arguments: { text: 'hi' } }),
              outputValue: JSON.stringify({
                content: [{ type: 'text', text: 'echo result', annotations: {}, meta: {} }],
                isError: false,
              }),
              tags: {
                ...TAGS,
                mcp_tool_kind: 'client',
                mcp_server_name: 'test-server',
                mcp_server_version: '1.0.0',
              },
            })

            assertLlmObsSpanEvent(serverSpan, {
              span: serverApmSpan,
              parentId: clientSpan.span_id,
              spanKind: 'tool',
              name: 'echo',
              inputValue: JSON.stringify({
                method: 'tools/call',
                params: { name: 'echo', arguments: { text: 'hi' }, _meta: { requestTag: 'abc' } },
                jsonrpc: '2.0',
                id,
              }),
              outputValue: JSON.stringify({ content: [{ type: 'text', text: 'echo result' }] }),
              tags: serverTags(setup, 'echo'),
            })
          })

          it('marks the server tool span as an error for an error result', async () => {
            const result = await client.callTool({ name: 'error-tool', arguments: {} })
            assert.equal(result.isError, true)

            const { apmSpans, llmobsSpans } = await getEvents(2)
            const serverSpan = llmobsSpans.find(span => span.name === 'error-tool')
            const { id } = JSON.parse(serverSpan.meta.input.value)

            assertLlmObsSpanEvent(serverSpan, {
              span: apmSpans.find(span => span.resource === 'server_tool_call'),
              parentId: llmobsSpans.find(span => span.name === 'MCP Client Tool Call: error-tool').span_id,
              spanKind: 'tool',
              name: 'error-tool',
              inputValue: JSON.stringify({
                method: 'tools/call',
                params: { name: 'error-tool', arguments: {} },
                jsonrpc: '2.0',
                id,
              }),
              outputValue: JSON.stringify({
                content: [{ type: 'text', text: 'Intentional tool error' }],
                isError: true,
              }),
              error: { type: MOCK_STRING, message: 'Intentional tool error', stack: MOCK_STRING },
              tags: serverTags(setup, 'error-tool'),
            })
          })

          it('creates only a client task span for Client.listTools', async () => {
            const result = await client.listTools()
            assert.equal(result.tools.length, 2)

            const { apmSpans, llmobsSpans } = await getEvents()

            assert.equal(llmobsSpans.length, 1)
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans.find(span => span.resource === 'ClientSession.list_tools'),
              spanKind: 'task',
              name: 'MCP Client List Tools',
              outputValue: JSON.stringify(result),
              tags: TAGS,
            })
          })
        })
      }
    })
  })
})
