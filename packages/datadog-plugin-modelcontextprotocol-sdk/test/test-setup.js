'use strict'

class ModelcontextprotocolSdkTestSetup {
  async setup (clientModule, versionMod) {
    this._versionMod = versionMod
    const path = require('path')
    const { Client } = clientModule
    // Use versionMod.getPath to resolve the SDK root since the package exports map
    // remaps @modelcontextprotocol/sdk/package.json to dist/cjs/package.json
    const clientEntryPath = versionMod.getPath('@modelcontextprotocol/sdk/client')
    const sdkDir = path.resolve(path.dirname(clientEntryPath), '..', '..', '..')
    const { McpServer } = require(path.join(sdkDir, 'dist/cjs/server/mcp.js'))
    const { InMemoryTransport } = versionMod.get('@modelcontextprotocol/sdk/inMemory.js')

    this._InMemoryTransport = InMemoryTransport

    this._server = new McpServer({ name: 'test-server', version: '1.0.0' })

    this._testTool = this._server.registerTool(
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

    this._server.registerResource(
      'test-resource',
      'file:///test-resource.txt',
      { description: 'A test resource', mimeType: 'text/plain' },
      async () => ({
        contents: [{ uri: 'file:///test-resource.txt', text: 'resource content' }],
      })
    )

    this._server.registerPrompt(
      'test-prompt',
      { description: 'A test prompt', argsSchema: {} },
      async () => ({
        messages: [{ role: 'user', content: { type: 'text', text: 'test prompt message' } }],
      })
    )

    const [clientTransport, serverTransport] = this._InMemoryTransport.createLinkedPair()

    await this._server.connect(serverTransport)

    this._client = new Client(
      { name: 'test-client', version: '1.0.0' }
    )
    await this._client.connect(clientTransport)
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

  async clientCallTool (name = 'test-tool') {
    return this._client.callTool({ name, arguments: { query: 'secret value' } })
  }

  async clientCallToolError () {
    return this._client.callTool({ name: 'error-tool', arguments: {} })
  }

  async clientListTools () {
    return this._client.listTools()
  }

  async clientListResources () {
    return this._client.listResources()
  }

  async clientReadResource () {
    return this._client.readResource({ uri: 'file:///test-resource.txt' })
  }

  async clientListPrompts () {
    return this._client.listPrompts()
  }

  async clientGetPrompt () {
    return this._client.getPrompt({ name: 'test-prompt', arguments: {} })
  }

  async clientSendUnknownMethod () {
    // Send a request for a method the server has no handler for (triggers MethodNotFound).
    // The client rejects with an McpError; catch it so the test can assert on the server span.
    const { EmptyResultSchema } = this._versionMod.get('@modelcontextprotocol/sdk/types.js')
    try {
      await this._client.request({ method: 'tools/unknown' }, EmptyResultSchema)
    } catch {
      // Expected — server returns MethodNotFound
    }
  }

  renameTestTool (name) {
    this._testTool.update({ name })
  }

  get server () {
    return this._server
  }
}

module.exports = ModelcontextprotocolSdkTestSetup
