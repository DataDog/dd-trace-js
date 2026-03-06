'use strict'

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const server = new McpServer({ name: 'test-server', version: '1.0.0' })

server.tool('echo', 'Echo a message back', { message: z.string() }, async ({ message }) => {
  return { content: [{ type: 'text', text: message }] }
})

server.resource('test-resource', 'file:///test/resource', async (uri) => {
  return { contents: [{ uri: uri.href, text: 'test resource content' }] }
})

const { completable } = require('@modelcontextprotocol/sdk/server/completable.js')

server.prompt(
  'test-prompt', 'A test prompt',
  { arg: completable(z.string().describe('An argument'), async () => ['option1', 'option2']).optional() },
  async (args) => {
    return { messages: [{ role: 'user', content: { type: 'text', text: 'Hello ' + (args.arg || 'world') } }] }
  }
)

async function main () {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main()
