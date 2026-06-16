'use strict'

const assert = require('node:assert/strict')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', {
  subModule: '@modelcontextprotocol/sdk/client',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod, meta.versionMod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('Client.callTool() - mcp.client.tool.call', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.client.tool.call',
        type: 'mcp',
        resource: 'test-tool',
        meta: {
          component: 'modelcontextprotocol_client',
          '_dd.integration': 'modelcontextprotocol_client',
          'span.kind': 'client',
        },
      })

      const result = await testSetup.clientCallTool()
      assert.ok(result.content, 'callTool should return a result with content')
      assert.equal(result.content.length, 1)
      assert.equal(result.content[0].type, 'text')
      assert.equal(result.content[0].text, 'Result from test-tool')

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.client.tool.call',
        type: 'mcp',
        resource: 'error-tool',
        error: 1,
        meta: {
          component: 'modelcontextprotocol_client',
          '_dd.integration': 'modelcontextprotocol_client',
          'span.kind': 'client',
        },
      })

      // In MCP SDK 1.27+, tool errors are returned as isError:true results, not thrown exceptions
      const result = await testSetup.clientCallToolError()
      assert.ok(result.isError, 'callTool result should have isError: true')
      assert.ok(result.content?.[0]?.text?.includes('Intentional test error'), 'error text should be in content')

      return traceAssertion
    })
  })

  describe('Client.listTools() - mcp.tools.list', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.tools.list',
        type: 'mcp',
        resource: 'tools/list',
        meta: {
          component: 'modelcontextprotocol_list_tools',
          '_dd.integration': 'modelcontextprotocol_list_tools',
          'span.kind': 'client',
        },
      })

      const result = await testSetup.clientListTools()
      assert.ok(result.tools, 'listTools should return tools array')
      assert.equal(result.tools.length, 2)

      return traceAssertion
    })
  })

  describe('Protocol.setRequestHandler - mcp.server.request', () => {
    it('should tag mcp.tool.name and mcp.request.arguments on tools/call', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        resource: 'tools/call',
        meta: {
          component: 'modelcontextprotocol_server',
          'mcp.tool.name': 'test-tool',
        },
      })

      await testSetup.clientCallTool()

      return traceAssertion
    })

    it('should tag mcp.tool.response on tools/call', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        resource: 'tools/call',
        meta: {
          'mcp.tool.response': 'Result from test-tool',
        },
      })

      await testSetup.clientCallTool()

      return traceAssertion
    })

    it('should tag mcp.tool.names on tools/list', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        resource: 'tools/list',
        meta: {
          component: 'modelcontextprotocol_server',
          'mcp.tool.names': 'test-tool,error-tool',
        },
      })

      await testSetup.clientListTools()

      return traceAssertion
    })

    it('should tag mcp.resource.uri on resources/read', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        resource: 'resources/read',
        meta: {
          component: 'modelcontextprotocol_server',
          'mcp.resource.uri': 'file:///test-resource.txt',
        },
      })

      await testSetup.clientReadResource()

      return traceAssertion
    })

    it('should tag mcp.resource.uris on resources/list', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        resource: 'resources/list',
        meta: {
          component: 'modelcontextprotocol_server',
          'mcp.resource.uris': 'file:///test-resource.txt',
        },
      })

      await testSetup.clientListResources()

      return traceAssertion
    })

    it('should tag mcp.prompt.name and mcp.request.arguments on prompts/get', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        resource: 'prompts/get',
        meta: {
          component: 'modelcontextprotocol_server',
          'mcp.prompt.name': 'test-prompt',
        },
      })

      await testSetup.clientGetPrompt()

      return traceAssertion
    })

    it('should tag mcp.prompt.names and mcp.prompt.descriptions on prompts/list', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        resource: 'prompts/list',
        meta: {
          component: 'modelcontextprotocol_server',
          'mcp.prompt.names': 'test-prompt',
          'mcp.prompt.descriptions': 'A test prompt',
        },
      })

      await testSetup.clientListPrompts()

      return traceAssertion
    })
  })

  describe('context propagation', () => {
    it('mcp.server.request span should be a child of mcp.client.tool.call span', async () => {
      // Client and server run in the same process via InMemoryTransport, so async
      // context propagation carries the client span into the server _onrequest handler.
      // Both spans land in the same trace payload.
      const traceAssertion = agent.assertSomeTraces(traces => {
        const allSpans = traces.flatMap(trace => trace)
        const clientSpan = allSpans.find(s => s.name === 'mcp.client.tool.call')
        const serverSpan = allSpans.find(s => s.name === 'mcp.server.request')
        assert.ok(clientSpan, 'mcp.client.tool.call span should exist')
        assert.ok(serverSpan, 'mcp.server.request span should exist')
        assert.strictEqual(
          serverSpan.parent_id.toString(),
          clientSpan.span_id.toString(),
          'server request span parent_id should equal client tool call span_id'
        )
      })

      await testSetup.clientCallTool()

      return traceAssertion
    })
  })

  describe('Protocol.setRequestHandler - transport disconnect (connection closed)', () => {
    it('should finish in-flight server request spans when the handler completes after transport closes', async () => {
      // The handler is wrapped at setRequestHandler time. When the transport disconnects,
      // the in-flight handler eventually resolves and the .finally() fires serverRequestFinishCh.
      const { McpServer } = meta.versionMod.get('@modelcontextprotocol/sdk/server/mcp.js')
      const { InMemoryTransport } = meta.versionMod.get('@modelcontextprotocol/sdk/inMemory.js')
      const { Client } = meta.mod

      const disconnectServer = new McpServer({ name: 'disconnect-server', version: '1.0.0' })

      let resumeSlowTool
      const holdPromise = new Promise(resolve => { resumeSlowTool = resolve })

      disconnectServer.registerTool(
        'slow-tool',
        { description: 'Slow tool', inputSchema: {} },
        async () => {
          await holdPromise
          return { content: [{ type: 'text', text: 'done' }] }
        }
      )

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await disconnectServer.connect(serverTransport)

      const disconnectClient = new Client({ name: 'disconnect-client', version: '1.0.0' })
      await disconnectClient.connect(clientTransport)

      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        type: 'mcp',
        resource: 'tools/call',
        meta: {
          component: 'modelcontextprotocol_server',
          '_dd.integration': 'modelcontextprotocol_server',
          'span.kind': 'server',
        },
      })

      // Fire the request without awaiting — it will block until holdPromise resolves.
      const callPromise = disconnectClient.callTool({ name: 'slow-tool', arguments: {} }).catch(() => {})

      // Give time for the request to reach the server and register an AbortController.
      await new Promise(resolve => setTimeout(resolve, 50))

      // Close the server, triggering _onclose() -> _requestHandlerAbortControllers.clear().
      await disconnectServer.close()
      resumeSlowTool()
      await callPromise

      return traceAssertion
    })
  })

  describe('McpServer.executeToolHandler - mcp.server.tool.call', () => {
    it('should generate server tool call span (happy path)', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.tool.call',
        type: 'mcp',
        resource: 'test-tool',
        meta: {
          component: 'modelcontextprotocol_server_tool',
          '_dd.integration': 'modelcontextprotocol_server_tool',
          'span.kind': 'internal',
        },
      })

      await testSetup.clientCallTool()

      return traceAssertion
    })

    it('should generate server tool call span with error (error path)', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.tool.call',
        type: 'mcp',
        error: 1,
        meta: {
          component: 'modelcontextprotocol_server_tool',
          '_dd.integration': 'modelcontextprotocol_server_tool',
          'span.kind': 'internal',
        },
      })

      await testSetup.clientCallToolError()

      return traceAssertion
    })
  })
})
