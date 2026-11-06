'use strict'

const assert = require('node:assert/strict')

const { after, before, describe, it } = require('mocha')

const { withVersions } = require('../../../setup/mocha')
const { assertLlmObsSpanEvent, useLlmObs } = require('../../util')

const SETUPS = [
  { name: 'in-memory transport', transport: 'memory', era: 'legacy' },
  { name: 'stateless HTTP, 2026-07-28 protocol', transport: 'http', mode: 'auto', era: 'modern' },
]

const TAGS = {
  ml_app: 'test',
  integration: 'modelcontextprotocol-sdk',
}

describe('integrations', () => {
  describe('modelcontextprotocol-sdk with SDK 2.x', () => {
    const { getEvents } = useLlmObs({ plugin: 'modelcontextprotocol-sdk' })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/client', (version) => {
      for (const setup of SETUPS) {
        describe(setup.name, () => {
          let client
          let closeServer

          before(async () => {
            const versionMod = require(`../../../../../../versions/@modelcontextprotocol/client@${version}`)
            const { Client, StreamableHTTPClientTransport } = versionMod.get('@modelcontextprotocol/client')
            const { createMcpHandler, InMemoryTransport, McpServer } = versionMod.get('@modelcontextprotocol/server')

            const createServer = () => {
              const server = new McpServer({ name: 'test-server', version: '1.0.0' })
              server.registerTool('echo', { description: 'Echoes a fixed text' }, async () => ({
                content: [{ type: 'text', text: 'echo result' }],
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
            } else {
              const handler = createMcpHandler(createServer)
              transport = new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
                fetch: (url, init) => handler.fetch(new Request(url, init)),
              })
              closeServer = () => handler.close()
            }

            const clientOptions = setup.mode && { versionNegotiation: { mode: setup.mode } }
            client = new Client({ name: 'test-client', version: '1.0.0' }, clientOptions)
            await client.connect(transport)
            assert.equal(client.getProtocolEra(), setup.era)
          })

          after(async () => {
            await client?.close()
            await closeServer?.()
          })

          it('creates a tool span for Client.callTool', async () => {
            const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } })
            assert.equal(result.content[0].text, 'echo result')

            const { apmSpans, llmobsSpans } = await getEvents()

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
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
          })

          it('creates a task span for Client.listTools', async () => {
            const result = await client.listTools()
            assert.equal(result.tools.length, 1)

            const { apmSpans, llmobsSpans } = await getEvents()

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
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
