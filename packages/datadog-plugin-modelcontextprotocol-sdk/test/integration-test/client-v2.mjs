import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'

function createServer () {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' })

  server.registerTool(
    'echo',
    { description: 'Echo tool' },
    async () => ({ content: [{ type: 'text', text: 'hello' }] })
  )

  server.registerResource(
    'test-resource',
    'file:///test-resource.txt',
    { description: 'A test resource', mimeType: 'text/plain' },
    async () => ({ contents: [{ uri: 'file:///test-resource.txt', text: 'resource content' }] })
  )

  server.registerPrompt(
    'test-prompt',
    { description: 'A test prompt' },
    async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'test prompt message' } }] })
  )

  return server
}

const handler = createMcpHandler(createServer)
const transport = new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
  fetch: (url, init) => handler.fetch(new Request(url, init)),
})

const client = new Client({ name: 'test-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
await client.connect(transport)

const era = client.getProtocolEra()
if (era !== 'modern') throw new Error(`Expected the 2026-07-28 protocol, got the ${era} protocol era`)

await client.listTools()
await client.callTool({ name: 'echo', arguments: {} })
await client.listResources()
await client.readResource({ uri: 'file:///test-resource.txt' })
await client.listPrompts()
await client.getPrompt({ name: 'test-prompt' })

await client.close()
await handler.close()
