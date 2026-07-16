import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'

const server = new McpServer({ name: 'test-server', version: '1.0.0' })

server.registerTool(
  'echo',
  { description: 'Echo tool', inputSchema: { message: z.string() } },
  async ({ message }) => ({ content: [{ type: 'text', text: message }] })
)

server.registerResource(
  'test-resource',
  'file:///test-resource.txt',
  { description: 'A test resource', mimeType: 'text/plain' },
  async () => ({ contents: [{ uri: 'file:///test-resource.txt', text: 'resource content' }] })
)

server.registerPrompt(
  'test-prompt',
  { description: 'A test prompt', argsSchema: {} },
  async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'test prompt message' } }] })
)

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)

const client = new Client({ name: 'test-client', version: '1.0.0' })
await client.connect(clientTransport)

await client.listTools()
await client.callTool({ name: 'echo', arguments: { message: 'hello' } })
await client.listResources()
await client.readResource({ uri: 'file:///test-resource.txt' })
await client.listPrompts()
await client.getPrompt({ name: 'test-prompt', arguments: {} })

await client.close()
await server.close()
