'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const SETUPS = [
  { name: 'in-memory transport', transport: 'memory', era: 'legacy' },
  { name: 'stateless HTTP, 2025-11-25 protocol', transport: 'http', mode: 'legacy', era: 'legacy' },
  { name: 'stateless HTTP, 2026-07-28 protocol', transport: 'http', mode: 'auto', era: 'modern' },
]

/**
 * @param {object} McpServer
 */
function createServer (McpServer) {
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

/**
 * Collects spans across payloads, because server spans parented through `_meta` flush apart from client spans.
 *
 * @param {(spans: object[]) => void} assertSpans
 */
function assertSpans (assertSpans) {
  const spans = []
  return agent.assertSomeTraces(traces => {
    spans.push(...traces.flat())
    assertSpans(spans)
  })
}

/**
 * @param {object[]} spans
 * @param {string} name
 * @param {string} resource
 */
function findSpan (spans, name, resource) {
  const span = spans.find(span => span.name === name && span.resource === resource)
  assert.ok(span, `${name} span with resource ${resource} should exist`)
  return span
}

/**
 * @param {object} child
 * @param {object} parent
 */
function assertChildOf (child, parent) {
  assert.equal(child.trace_id.toString(), parent.trace_id.toString())
  assert.equal(child.parent_id.toString(), parent.span_id.toString())
}

describe('Plugin', () => {
  describe('modelcontextprotocol-sdk with SDK 2.x', () => {
    // Each 2.x package folder also installs the latest release of the other package.
    for (const [integration, packageName] of [
      ['modelcontextprotocol-sdk', '@modelcontextprotocol/client'],
      ['modelcontextprotocol-server', '@modelcontextprotocol/server'],
    ]) {
      withVersions(integration, packageName, (version, moduleName) => {
        before(() => agent.load('modelcontextprotocol-sdk'))

        after(() => agent.close())

        for (const setup of SETUPS) {
          describe(setup.name, () => {
            let client
            let closeServer

            before(async () => {
              const tracer = require('../../dd-trace')
              const versionMod = require(`../../../versions/${moduleName}@${version}`)
              const { Client, StreamableHTTPClientTransport } = versionMod.get('@modelcontextprotocol/client')
              const { createMcpHandler, InMemoryTransport, McpServer } = versionMod.get('@modelcontextprotocol/server')

              let transport
              if (setup.transport === 'memory') {
                const server = createServer(McpServer)
                const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
                await server.connect(serverTransport)
                transport = clientTransport
                closeServer = () => server.close()
              } else {
                const handler = createMcpHandler(() => createServer(McpServer))
                transport = new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
                // Serve each request without the client's active span, so only `_meta` can parent server spans
                  fetch: (url, init) => tracer.scope().activate(null, () => handler.fetch(new Request(url, init))),
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

            afterEach(() => agent.reset())

            it('traces a tool call on the client and the server', async () => {
              const tracesPromise = assertSpans(spans => {
                const clientSpan = findSpan(spans, 'mcp.request', 'client_tool_call')
                const serverSpan = findSpan(spans, 'mcp.request', 'server_tool_call')
                const toolSpan = findSpan(spans, 'mcp.server.tool.call', 'echo')

                assert.equal(clientSpan.meta.component, 'modelcontextprotocol_client')
                assert.equal(clientSpan.meta['span.kind'], 'client')
                assert.equal(serverSpan.meta.component, 'modelcontextprotocol_server')
                assert.equal(serverSpan.meta['span.kind'], 'server')
                assert.equal(toolSpan.meta.component, 'modelcontextprotocol_server_tool')
                assertChildOf(serverSpan, clientSpan)
                assertChildOf(toolSpan, serverSpan)
              })

              const result = await client.callTool({ name: 'echo', arguments: {} })
              assert.equal(result.content[0].text, 'echo result')

              await tracesPromise
            })

            it('tags tool error results', async () => {
              const tracesPromise = assertSpans(spans => {
                const clientSpan = findSpan(spans, 'mcp.request', 'client_tool_call')
                const serverSpan = findSpan(spans, 'mcp.request', 'server_tool_call')
                const toolSpan = findSpan(spans, 'mcp.server.tool.call', 'error-tool')

                for (const span of [clientSpan, serverSpan, toolSpan]) {
                  assert.equal(span.error, 1)
                  assert.equal(span.meta['error.message'], 'Intentional tool error')
                }
              })

              const result = await client.callTool({ name: 'error-tool', arguments: {} })
              assert.equal(result.isError, true)

              await tracesPromise
            })

            it('traces listing tools on the client and the server', async () => {
              const tracesPromise = assertSpans(spans => {
                const clientSpan = findSpan(spans, 'mcp.request', 'ClientSession.list_tools')
                const serverSpan = findSpan(spans, 'mcp.request', 'tools/list')

                assert.equal(clientSpan.meta.component, 'modelcontextprotocol_list_tools')
                assertChildOf(serverSpan, clientSpan)
              })

              const result = await client.listTools()
              assert.deepEqual(result.tools.map(tool => tool.name), ['echo', 'error-tool'])

              await tracesPromise
            })
          })
        }

        it('finishes an in-flight server request span with an error when the transport closes', async () => {
          const versionMod = require(`../../../versions/${moduleName}@${version}`)
          const { Client } = versionMod.get('@modelcontextprotocol/client')
          const { InMemoryTransport, McpServer } = versionMod.get('@modelcontextprotocol/server')

          let markStarted
          const started = new Promise(resolve => { markStarted = resolve })
          let release
          const held = new Promise(resolve => { release = resolve })

          const server = new McpServer({ name: 'disconnect-server', version: '1.0.0' })
          server.registerTool('slow-tool', { description: 'Waits until released' }, async () => {
            markStarted()
            await held
            return { content: [{ type: 'text', text: 'done' }] }
          })

          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
          await server.connect(serverTransport)
          const client = new Client({ name: 'test-client', version: '1.0.0' })
          await client.connect(clientTransport)

          const tracesPromise = assertSpans(spans => {
            const serverSpan = findSpan(spans, 'mcp.request', 'server_tool_call')
            assert.equal(serverSpan.error, 1)
            assert.equal(serverSpan.meta['error.type'], 'McpError')
            assert.equal(serverSpan.meta['error.message'], 'Connection closed')
          })

          const callPromise = client.callTool({ name: 'slow-tool', arguments: {} })
          await started
          await server.close()
          release()

          await Promise.all([tracesPromise, assert.rejects(callPromise)])
          await client.close()
        })
      })
    }
  })
})
