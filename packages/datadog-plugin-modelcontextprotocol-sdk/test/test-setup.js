'use strict'

class ModelcontextprotocolSdkTestSetup {
  async setup (clientModule) {
    const { Client } = clientModule
    const { Server } = require('@modelcontextprotocol/sdk/server')
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')
    const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js')

    this._Client = Client
    this._Server = Server
    this._InMemoryTransport = InMemoryTransport
    this._CallToolRequestSchema = CallToolRequestSchema
    this._ListToolsRequestSchema = ListToolsRequestSchema

    this._server = new Server(
      { name: 'test-server', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )

    this._server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name
      if (toolName === 'error-tool') {
        throw new Error('Intentional test error')
      }
      return {
        content: [{ type: 'text', text: `Result from ${toolName}` }],
      }
    })

    this._server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          { name: 'test-tool', description: 'A test tool', inputSchema: { type: 'object' } },
          { name: 'error-tool', description: 'A tool that errors', inputSchema: { type: 'object' } },
        ],
      }
    })

    const [clientTransport, serverTransport] = this._InMemoryTransport.createLinkedPair()

    await this._server.connect(serverTransport)

    this._client = new Client(
      { name: 'test-client', version: '1.0.0' }
    )
    await this._client.connect(clientTransport)

    this._clientTransport = clientTransport
    this._serverTransport = serverTransport
  }

  async teardown () {
    if (this._client) {
      await this._client.close()
    }
    if (this._server) {
      await this._server.close()
    }
    this._client = null
    this._server = null
  }

  async clientCallTool () {
    return this._client.callTool({ name: 'test-tool', arguments: {} })
  }

  async clientCallToolError () {
    return this._client.callTool({ name: 'error-tool', arguments: {} })
  }

  async clientListTools () {
    return this._client.listTools()
  }

  async clientReconnect () {
    const [clientTransport, serverTransport] = this._InMemoryTransport.createLinkedPair()
    const server = new this._Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } })
    await server.connect(serverTransport)
    const client = new this._Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(clientTransport)
    await client.close()
    await server.close()
  }
}

module.exports = ModelcontextprotocolSdkTestSetup
