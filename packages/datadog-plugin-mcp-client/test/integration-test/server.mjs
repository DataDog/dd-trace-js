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

const resourceResult = await client.getResource({ uri: 'file:///test/resource' })
assert.ok(resourceResult.contents, 'getResource should return contents')
assert.strictEqual(resourceResult.contents[0].text, 'test resource content', 'getResource should return expected text')

const promptResult = await client.getPrompt({ name: 'test-prompt', arguments: { arg: 'hello' } })
assert.ok(promptResult.messages, 'getPrompt should return messages')
assert.strictEqual(promptResult.messages[0].content.text, 'Hello hello', 'getPrompt should return expected message')

const completeResult = await client.complete({
  ref: { type: 'ref/prompt', name: 'test-prompt' },
  argument: { name: 'arg', value: 'test' },
})
assert.ok(completeResult.completion, 'complete should return completion')
assert.ok(completeResult.completion.values, 'complete should return completion values')

await client.close()
