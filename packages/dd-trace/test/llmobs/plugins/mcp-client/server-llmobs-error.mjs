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

// First make a successful callTool so we have a baseline span
const callToolResult = await client.callTool({ name: 'echo', arguments: { message: 'hello' } })
assert.ok(callToolResult.content, 'callTool should return content')

// Trigger an error by calling a tool that doesn't exist.
// The MCP SDK should throw an McpError for unknown tools, which goes through
// the orchestrion error path (ctx.error is set, error channel fires).
try {
  await client.callTool({ name: 'nonexistent_tool_that_does_not_exist', arguments: {} })
} catch (e) {
  // expected - tool does not exist on the server
}

// Also try with AbortController to produce a second error approach
try {
  const ac = new AbortController()
  ac.abort()
  await client.callTool(
    { name: 'echo', arguments: { message: 'aborted' } },
    { requestOptions: { signal: ac.signal } }
  )
} catch (e) {
  // expected - aborted
}

// Allow time for spans to be flushed before closing
await new Promise(resolve => setTimeout(resolve, 1500))

await client.close()
