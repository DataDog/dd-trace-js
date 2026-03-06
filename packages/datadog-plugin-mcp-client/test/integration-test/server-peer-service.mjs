import 'dd-trace/init.js'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MCPClient } from 'mcp-client'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverPath = join(__dirname, 'mcp-test-server.js')

const client = new MCPClient(
  { name: 'test-client', version: '1.0.0' }
)

await client.connect({
  type: 'stdio',
  command: 'node',
  args: [serverPath],
})

const callToolResult = await client.callTool({ name: 'echo', arguments: { message: 'hello' } })
assert.ok(callToolResult.content, 'callTool should return content')
assert.strictEqual(callToolResult.content[0].text, 'hello', 'callTool should echo the message')

await client.close()
