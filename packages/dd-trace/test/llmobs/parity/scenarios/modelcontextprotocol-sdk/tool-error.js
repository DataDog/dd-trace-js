'use strict'

const path = require('node:path')

const { finish, loadTracer } = require('../common')

async function main () {
  const tracer = loadTracer('modelcontextprotocol-sdk')
  const sdkFixture = require('../../../../../../../versions/@modelcontextprotocol/sdk@1.27.1')
  const { z } = sdkFixture.get('zod')
  const { Client } = sdkFixture.get('@modelcontextprotocol/sdk/client')
  const { InMemoryTransport } = sdkFixture.get('@modelcontextprotocol/sdk/inMemory.js')
  const sdkDir = path.resolve(path.dirname(sdkFixture.getPath('@modelcontextprotocol/sdk/client')), '..', '..', '..')
  const { McpServer } = require(path.join(sdkDir, 'dist/cjs/server/mcp.js'))
  const server = new McpServer({ name: 'TestServer', version: '1.0.0' })
  server.registerTool(
    'failing_tool',
    {
      description: 'This tool always raises an exception.',
      inputSchema: { param: z.string() },
    },
    async () => {
      throw new Error('Tool execution failed')
    }
  )
  const client = new Client({ name: 'mcp', version: '0.1.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  await client.callTool({ name: 'failing_tool', arguments: { param: 'value' } })
  await client.close()
  await server.close()
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
