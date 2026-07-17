import { loadMcpTools } from '@langchain/mcp-adapters'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const server = new McpServer({ name: 'test-server', version: '1.0.0' })
server.registerTool(
  'echo',
  { description: 'Echo tool', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'hello' }] })
)

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)

const client = new Client({ name: 'test-client', version: '1.0.0' })
await client.connect(clientTransport)

const [tool] = await loadMcpTools('repro', client, {
  prefixToolNameWithServerName: true,
  additionalToolNamePrefix: 'mcp',
})
await tool.invoke({})

await new Promise(resolve => setTimeout(resolve, 100))
await client.close()
await server.close()
