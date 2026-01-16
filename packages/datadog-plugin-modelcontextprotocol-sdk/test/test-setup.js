'use strict'

/**
 * Sample application for MCP SDK instrumentation testing.
 * Tests client operations using in-memory transport with a mock server.
 * Note: Server-side instrumentation was removed due to Orchestrion AST rewriting
 * issues with methods that use 'super' keyword.
 */

let Client
let Server
let InMemoryTransport

class ModelcontextprotocolSdkTestSetup {
  async setup (module) {
    // The @modelcontextprotocol/sdk main export is broken (dist/cjs/index.js doesn't exist).
    // We need to import from specific subpaths that DO exist.
    const clientModule = require('@modelcontextprotocol/sdk/client')
    const serverModule = require('@modelcontextprotocol/sdk/server')
    const inMemoryModule = require('@modelcontextprotocol/sdk/inMemory.js')

    Client = clientModule.Client
    Server = serverModule.Server
    InMemoryTransport = inMemoryModule.InMemoryTransport

    this.client = null
    this.server = null
    this.clientTransport = null
    this.serverTransport = null

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    this.clientTransport = clientTransport
    this.serverTransport = serverTransport

    this.server = new Server(
      { name: 'test-server', version: '1.0.0' },
      { capabilities: { tools: {}, resources: {} } }
    )

    const {
      CallToolRequestSchema,
      ListToolsRequestSchema,
      ListResourcesRequestSchema,
      ReadResourceRequestSchema
    } = require('@modelcontextprotocol/sdk/types.js')

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'echo',
            description: 'Echoes the input',
            inputSchema: { type: 'object', properties: { message: { type: 'string' } } }
          },
          {
            name: 'divide',
            description: 'Divides numbers',
            inputSchema: {
              type: 'object',
              properties: { numerator: { type: 'number' }, denominator: { type: 'number' } }
            }
          }
        ]
      }
    })

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params
      if (name === 'echo') {
        return { content: [{ type: 'text', text: `Echo: ${args.message}` }] }
      }
      if (name === 'divide') {
        if (args.denominator === 0) {
          return { content: [{ type: 'text', text: 'Error: Division by zero' }], isError: true }
        }
        return { content: [{ type: 'text', text: `Result: ${args.numerator / args.denominator}` }] }
      }
      if (name === 'error_tool') {
        // Throw an actual error for testing error capture
        throw new Error('Tool execution failed')
      }
      return { content: [{ type: 'text', text: 'Unknown tool' }], isError: true }
    })

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: [
          { name: 'test-data', uri: 'data://test/sample', description: 'A sample resource', mimeType: 'text/plain' }
        ]
      }
    })

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params
      if (uri === 'data://test/sample') {
        return { contents: [{ uri, mimeType: 'text/plain', text: 'This is sample test data.' }] }
      }
      throw new Error(`Resource not found: ${uri}`)
    })

    // Create the client
    this.client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} }
    )

    // Connect server to its transport (must be done before client connects)
    await this.server.connect(serverTransport)

    // Connect client to its transport
    await this.client.connect(this.clientTransport)
  }

  async teardown () {
    try {
      if (this.client) {
        await this.client.close()
      }
    } catch (error) {
      console.error('Failed to close client:', error)
    }

    try {
      if (this.server) {
        await this.server.close()
      }
    } catch (error) {
      console.error('Failed to close server:', error)
    }

    this.client = null
    this.server = null
  }

  // --- Client Operations (instrumented) ---
  async clientConnect () {
    return this.client.connect(this.clientTransport)
  }

  async clientCallTool () {
    const params = {
      name: 'echo',
      arguments: { message: 'Hello from MCP client!' }
    }
    return this.client.callTool(params)
  }

  getServerInfo () {
    return this.client.getServerVersion?.() || this.client._serverVersion
  }

  async clientCallToolError () {
    // Call a tool that throws an actual error
    const params = {
      name: 'error_tool',
      arguments: {}
    }
    return this.client.callTool(params)
  }

  async clientListTools () {
    return this.client.listTools()
  }

  async clientListResources () {
    return this.client.listResources()
  }

  async clientReadResource () {
    const params = { uri: 'data://test/sample' }
    return this.client.readResource(params)
  }

  async clientReadResourceError () {
    const params = { uri: 'data://nonexistent/resource' }
    return this.client.readResource(params)
  }

  async clientClose () {
    return this.client.close()
  }

  async clientCloseError () {
    // Create a client that's not connected to simulate error
    const badClient = new Client({ name: 'bad-client', version: '1.0.0' }, { capabilities: {} })
    return badClient.close()
  }

  async clientConnectError () {
    // Try to connect with invalid transport to trigger error
    const badClient = new Client({ name: 'bad-client', version: '1.0.0' }, { capabilities: {} })
    return badClient.connect(null)
  }

  // Protocol.request - exposed via client
  async protocolRequest () {
    // Protocol.request is called internally by client methods
    // We can call it via listTools which uses request under the hood
    return this.client.listTools()
  }

  async protocolRequestError () {
    // Make an invalid request that will fail
    const badClient = new Client({ name: 'bad-client', version: '1.0.0' }, { capabilities: {} })
    return badClient.listTools()
  }

  async clientListToolsError () {
    // Disconnect and try to list tools
    const badClient = new Client({ name: 'bad-client', version: '1.0.0' }, { capabilities: {} })
    return badClient.listTools()
  }

  async clientListResourcesError () {
    const badClient = new Client({ name: 'bad-client', version: '1.0.0' }, { capabilities: {} })
    return badClient.listResources()
  }

  // McpServer operations - Note: Not instrumented due to 'super' keyword usage in SDK
  async mcpServerConnect () {
    // Server connect is not instrumented - just a stub
    return Promise.resolve()
  }

  async mcpServerConnectError () {
    return Promise.reject(new Error('Server connect not instrumented'))
  }

  async mcpServerClose () {
    // Server close is not instrumented - just a stub
    return Promise.resolve()
  }

  async mcpServerCloseError () {
    return Promise.reject(new Error('Server close not instrumented'))
  }

  async mcpServerExecuteToolHandler () {
    // executeToolHandler is not instrumented - just a stub
    return Promise.resolve()
  }

  async mcpServerExecuteToolHandlerError () {
    return Promise.reject(new Error('executeToolHandler not instrumented'))
  }
}

module.exports = ModelcontextprotocolSdkTestSetup
