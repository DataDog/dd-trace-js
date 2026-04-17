'use strict'

class ModelcontextprotocolSdkTestSetup {
  async setup (clientModule, versionMod) {
    const path = require('path')
    const { Client } = clientModule
    // Use versionMod.getPath to resolve the SDK root since the package exports map
    // remaps @modelcontextprotocol/sdk/package.json to dist/cjs/package.json
    const clientEntryPath = versionMod.getPath('@modelcontextprotocol/sdk/client')
    const sdkDir = path.resolve(path.dirname(clientEntryPath), '..', '..', '..')
    const { McpServer } = require(path.join(sdkDir, 'dist/cjs/server/mcp.js'))
    const { InMemoryTransport } = versionMod.get('@modelcontextprotocol/sdk/inMemory.js')

    this._Client = Client
    this._McpServer = McpServer
    this._InMemoryTransport = InMemoryTransport
    this._sdkDir = sdkDir

    this._server = new McpServer({ name: 'test-server', version: '1.0.0' })

    this._server.registerTool(
      'test-tool',
      { description: 'A test tool', inputSchema: {} },
      async () => ({
        content: [{ type: 'text', text: 'Result from test-tool' }],
      })
    )

    this._server.registerTool(
      'error-tool',
      { description: 'A tool that errors', inputSchema: {} },
      async () => {
        throw new Error('Intentional test error')
      }
    )

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
    const path = require('path')
    const { McpServer } = require(path.join(this._sdkDir, 'dist/cjs/server/mcp.js'))
    const [clientTransport, serverTransport] = this._InMemoryTransport.createLinkedPair()
    const server = new McpServer({ name: 'test-server', version: '1.0.0' })
    await server.connect(serverTransport)
    const client = new this._Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(clientTransport)
    await client.close()
    await server.close()
  }
}

module.exports = ModelcontextprotocolSdkTestSetup
