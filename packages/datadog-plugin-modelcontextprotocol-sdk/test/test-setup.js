'use strict'

class ModelcontextprotocolSdkTestSetup {
  #client
  #server
  #testTool
  #versionMod

  async setup (clientModule, versionMod) {
    this.#versionMod = versionMod
    const path = require('path')
    const { Client } = clientModule
    // Use versionMod.getPath to resolve the SDK root since the package exports map
    // remaps @modelcontextprotocol/sdk/package.json to dist/cjs/package.json
    const clientEntryPath = versionMod.getPath('@modelcontextprotocol/sdk/client')
    const sdkDir = path.resolve(path.dirname(clientEntryPath), '..', '..', '..')
    const { McpServer } = require(path.join(sdkDir, 'dist/cjs/server/mcp.js'))
    const { InMemoryTransport } = versionMod.get('@modelcontextprotocol/sdk/inMemory.js')

    this.#server = new McpServer({ name: 'test-server', version: '1.0.0' })

    this.#testTool = this.#server.registerTool(
      'test-tool',
      { description: 'A test tool', inputSchema: {} },
      async () => ({
        content: [{ type: 'text', text: 'Result from test-tool' }],
      })
    )

    this.#server.registerTool(
      'error-tool',
      { description: 'A tool that errors', inputSchema: {} },
      async () => {
        throw new Error('Intentional test error')
      }
    )

    this.#server.registerResource(
      'test-resource',
      'file:///test-resource.txt',
      { description: 'A test resource', mimeType: 'text/plain' },
      async () => ({
        contents: [{ uri: 'file:///test-resource.txt', text: 'resource content' }],
      })
    )

    this.#server.registerPrompt(
      'test-prompt',
      { description: 'A test prompt', argsSchema: {} },
      async () => ({
        messages: [{ role: 'user', content: { type: 'text', text: 'test prompt message' } }],
      })
    )

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await this.#server.connect(serverTransport)

    this.#client = new Client(
      { name: 'test-client', version: '1.0.0' }
    )
    await this.#client.connect(clientTransport)
  }

  async teardown () {
    if (this.#client) {
      await this.#client.close()
    }
    if (this.#server) {
      await this.#server.close()
    }
    this.#client = undefined
    this.#server = undefined
    this.#testTool = undefined
  }

  async clientCallTool (name = 'test-tool') {
    return this.#client.callTool({ name, arguments: { query: 'secret value' } })
  }

  async clientCallToolError () {
    return this.#client.callTool({ name: 'error-tool', arguments: {} })
  }

  async clientListTools () {
    return this.#client.listTools()
  }

  async clientListResources () {
    return this.#client.listResources()
  }

  async clientListResourceTemplates () {
    return this.#client.listResourceTemplates()
  }

  async clientReadResource () {
    return this.#client.readResource({ uri: 'file:///test-resource.txt' })
  }

  async clientListPrompts () {
    return this.#client.listPrompts()
  }

  async clientGetPrompt () {
    return this.#client.getPrompt({ name: 'test-prompt', arguments: {} })
  }

  async clientSendUnknownMethod () {
    // Send a request for a method the server has no handler for (triggers MethodNotFound).
    // The client rejects with an McpError; catch it so the test can assert on the server span.
    const { EmptyResultSchema } = this.#versionMod.get('@modelcontextprotocol/sdk/types.js')
    try {
      await this.#client.request({ method: 'tools/unknown' }, EmptyResultSchema)
    } catch {
      // Expected — server returns MethodNotFound
    }
  }

  clientCallMalformedTool () {
    const { EmptyResultSchema } = this.#versionMod.get('@modelcontextprotocol/sdk/types.js')
    return this.#client.request({ method: 'tools/call', params: { arguments: {} } }, EmptyResultSchema)
  }

  renameTestTool (name) {
    this.#testTool.update({ name })
  }

  get server () {
    return this.#server
  }
}

module.exports = ModelcontextprotocolSdkTestSetup
