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

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)

const client = new Client({ name: 'test-client', version: '1.0.0' })
await client.connect(clientTransport)

await client.listTools()
await client.callTool({ name: 'echo', arguments: { message: 'hello' } })

await client.close()
await server.close()
