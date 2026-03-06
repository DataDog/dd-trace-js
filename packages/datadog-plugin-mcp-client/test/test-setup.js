'use strict'

const path = require('node:path')

class McpClientTestSetup {
  async setup (module) {
    this.client = null
    this.MCPClient = module.MCPClient
    this.serverPath = path.join(__dirname, 'mcp-test-server.js')
    this.client = new this.MCPClient(
      { name: 'sample-app-client', version: '1.0.0' }
    )

    await this.client.connect({
      type: 'stdio',
      command: 'node',
      args: [this.serverPath],
    })
  }

  async teardown () {
    if (this.client) {
      await this.client.close()
    }
  }

  // --- Operations ---

  async mcpClientCallTool () {
    return this.client.callTool({ name: 'echo', arguments: { message: 'hello' } })
  }

  async mcpClientCallToolError () {
    const controller = new AbortController()
    controller.abort()
    return this.client.callTool(
      { name: 'echo', arguments: { message: 'hello' } },
      { requestOptions: { signal: controller.signal } }
    )
  }

  async mcpClientGetResource () {
    return this.client.getResource({ uri: 'file:///test/resource' })
  }

  async mcpClientGetResourceError () {
    return this.client.getResource({ uri: 'file:///nonexistent/resource/that/does/not/exist' })
  }

  async mcpClientGetPrompt () {
    return this.client.getPrompt({ name: 'test-prompt', arguments: { arg: 'hello' } })
  }

  async mcpClientGetPromptError () {
    return this.client.getPrompt({ name: 'nonexistent_prompt_that_does_not_exist' })
  }

  async mcpClientComplete () {
    return this.client.complete({
      ref: { type: 'ref/prompt', name: 'test-prompt' },
      argument: { name: 'arg', value: 'test' },
    })
  }

  async mcpClientCompleteError () {
    return this.client.complete({
      ref: { type: 'ref/prompt', name: 'nonexistent_prompt_that_does_not_exist' },
      argument: { name: 'arg', value: 'test' },
    })
  }
}

module.exports = McpClientTestSetup
