'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')

const { storage } = require('../../datadog-core')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()
const legacyStorage = storage('legacy')

describe('plugin lifecycle', () => {
  it('does not subscribe to server tool registration when the plugin module is loaded', () => {
    const registeredCh = channel('apm:mcp:server:tool:registered')
    assert.strictEqual(registeredCh.hasSubscribers, false)

    delete require.cache[require.resolve('../src/tracing')]
    require('../src/tracing')

    assert.strictEqual(registeredCh.hasSubscribers, false)
  })
})

function assertClientServerParenting (spans, clientResource) {
  const clientSpan = spans.find(s => {
    return s.name === 'mcp.client.tool.call' && s.resource === clientResource
  })
  const serverSpan = spans.find(s => {
    return s.name === 'mcp.server.request' && s.resource === 'tools/call'
  })

  assert.ok(clientSpan, 'mcp.client.tool.call span should exist')
  assert.ok(serverSpan, 'mcp.server.request span should exist')
  assert.strictEqual(
    serverSpan.trace_id.toString(),
    clientSpan.trace_id.toString(),
    'server request span trace_id should equal client tool call trace_id'
  )
  assert.strictEqual(
    serverSpan.parent_id.toString(),
    clientSpan.span_id.toString(),
    'server request span parent_id should equal client tool call span_id'
  )
}

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

    it('should use a fallback error message when an isError result has no text content', async () => {
      const emptyErrorTool = testSetup.server.registerTool(
        'empty-error-tool',
        { description: 'A tool with an empty error result', inputSchema: {} },
        async () => ({ content: [], isError: true })
      )

      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.tool.call',
        type: 'mcp',
        resource: 'empty-error-tool',
        error: 1,
        meta: {
          component: 'modelcontextprotocol_server_tool',
          '_dd.integration': 'modelcontextprotocol_server_tool',
          'span.kind': 'internal',
          'error.message': 'Tool call returned isError: true',
        },
      })

      try {
        await testSetup.clientCallTool('empty-error-tool')

        return await traceAssertion
      } finally {
        emptyErrorTool.disable()
      }
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

  describe('Client.listResources() - mcp.resources.list', () => {
    it('should generate span with correct tags', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.resources.list',
        type: 'mcp',
        resource: 'resources/list',
        meta: { component: 'modelcontextprotocol_list_resources', 'span.kind': 'client' },
      })
      await testSetup.clientListResources()
      return traceAssertion
    })
  })

  describe('Client.readResource() - mcp.resource.read', () => {
    it('should generate span with resource uri as resource tag', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.resource.read',
        type: 'mcp',
        resource: 'file:///test-resource.txt',
        meta: { component: 'modelcontextprotocol_read_resource', 'span.kind': 'client' },
      })
      await testSetup.clientReadResource()
      return traceAssertion
    })
  })

  describe('Client.listPrompts() - mcp.prompts.list', () => {
    it('should generate span with correct tags', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.prompts.list',
        type: 'mcp',
        resource: 'prompts/list',
        meta: { component: 'modelcontextprotocol_list_prompts', 'span.kind': 'client' },
      })
      await testSetup.clientListPrompts()
      return traceAssertion
    })
  })

  describe('Client.getPrompt() - mcp.prompt.get', () => {
    it('should generate span with prompt name as resource tag', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.prompt.get',
        type: 'mcp',
        resource: 'test-prompt',
        meta: { component: 'modelcontextprotocol_get_prompt', 'span.kind': 'client' },
      })
      await testSetup.clientGetPrompt()
      return traceAssertion
    })
  })

  describe('Protocol.setRequestHandler - mcp.server.request', () => {
    it('should tag mcp.tool.name and argument shape on tools/call', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        resource: 'tools/call',
        meta: {
          component: 'modelcontextprotocol_server',
          'mcp.tool.name': 'test-tool',
          'mcp.request.argument_keys': 'query',
        },
        metrics: {
          'mcp.request.argument_count': 1,
        },
      })

      await testSetup.clientCallTool()

      return traceAssertion
    })

    it('should tag mcp.tool.response shape on tools/call', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        resource: 'tools/call',
        meta: {
          'mcp.tool.response.content_types': 'text',
        },
        metrics: {
          'mcp.tool.response.content_count': 1,
        },
      })

      await testSetup.clientCallTool()

      return traceAssertion
    })

    it('should not tag raw tool arguments or response content on tools/call', async () => {
      const traceAssertion = agent.assertSomeTraces(traces => {
        const spans = traces.flatMap(trace => trace)
        const span = spans.find(span => {
          return span.name === 'mcp.server.request' && span.resource === 'tools/call'
        })

        assert.ok(span, 'mcp.server.request span should exist')
        assert.strictEqual(Object.hasOwn(span.meta, 'mcp.request.arguments'), false)
        assert.strictEqual(Object.hasOwn(span.meta, 'mcp.tool.response'), false)
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

    it('should generate server request span with error when tools/call returns isError', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        type: 'mcp',
        resource: 'tools/call',
        error: 1,
        meta: {
          component: 'modelcontextprotocol_server',
          '_dd.integration': 'modelcontextprotocol_server',
          'span.kind': 'server',
        },
      })

      await testSetup.clientCallToolError()

      return traceAssertion
    })

    it('should finish server request spans with error when tools/call request validation fails', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        type: 'mcp',
        resource: 'tools/call',
        error: 1,
        meta: {
          component: 'modelcontextprotocol_server',
          '_dd.integration': 'modelcontextprotocol_server',
          'span.kind': 'server',
        },
      })

      await assert.rejects(
        () => testSetup.clientCallMalformedTool(),
        { message: /expected string/ }
      )

      return traceAssertion
    })

    it('should finish server request spans with error when a custom handler rejects', async () => {
      const { ListResourceTemplatesRequestSchema } = meta.versionMod.get('@modelcontextprotocol/sdk/types.js')

      testSetup.server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
        throw new Error('template handler failed')
      })

      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        type: 'mcp',
        resource: 'resources/templates/list',
        error: 1,
        meta: {
          component: 'modelcontextprotocol_server',
          '_dd.integration': 'modelcontextprotocol_server',
          'span.kind': 'server',
          'error.message': 'template handler failed',
        },
      })

      await assert.rejects(
        () => testSetup.clientListResourceTemplates(),
        { message: /template handler failed/ }
      )

      return traceAssertion
    })

    it('should finish server request spans for allowlisted unknown methods', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.request',
        type: 'mcp',
        resource: 'tools/unknown',
        meta: {
          component: 'modelcontextprotocol_server',
          '_dd.integration': 'modelcontextprotocol_server',
          'span.kind': 'server',
        },
      })

      await testSetup.clientSendUnknownMethod()

      return traceAssertion
    })
  })

  describe('context propagation', () => {
    it('mcp.server.request span should be a child of mcp.client.tool.call span', async () => {
      // Client and server run in the same process via InMemoryTransport, so async
      // context propagation carries the client span into the server _onrequest handler.
      // Distributed extraction can split linked spans across trace payloads, so aggregate
      // the mock agent payloads before asserting the relationship.
      const spans = []
      const traceAssertion = agent.assertSomeTraces(traces => {
        spans.push(...traces.flatMap(trace => trace))
        assertClientServerParenting(spans, 'test-tool')
      })

      await testSetup.clientCallTool()

      return traceAssertion
    })

    it('mcp.server.request span should use _meta trace context when async context is absent', async () => {
      const { McpServer } = meta.versionMod.get('@modelcontextprotocol/sdk/server/mcp.js')
      const { InMemoryTransport } = meta.versionMod.get('@modelcontextprotocol/sdk/inMemory.js')
      const { Client } = meta.mod

      const distributedServer = new McpServer({ name: 'distributed-server', version: '1.0.0' })
      distributedServer.registerTool(
        'distributed-tool',
        { description: 'Distributed tool', inputSchema: {} },
        async () => ({
          content: [{ type: 'text', text: 'distributed result' }],
        })
      )

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await distributedServer.connect(serverTransport)

      const serverOnMessage = serverTransport.onmessage
      let traceContext
      serverTransport.onmessage = (...args) => {
        traceContext = args[0]?.params?._meta?._dd_trace_context
        return legacyStorage.run({}, () => serverOnMessage.apply(serverTransport, args))
      }

      const distributedClient = new Client({ name: 'distributed-client', version: '1.0.0' })
      await distributedClient.connect(clientTransport)

      const spans = []
      const traceAssertion = agent.assertSomeTraces(traces => {
        spans.push(...traces.flatMap(trace => trace))
        assertClientServerParenting(spans, 'distributed-tool')
      })

      try {
        await distributedClient.callTool({ name: 'distributed-tool', arguments: {} })

        assert.ok(traceContext, 'request should include _meta._dd_trace_context')
        assert.ok(
          traceContext['x-datadog-trace-id'] || traceContext.traceparent,
          'trace context should include a supported propagation header'
        )

        return traceAssertion
      } finally {
        await distributedClient.close()
        await distributedServer.close()
      }
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

    it('should update server tool call span resource when tool is renamed', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.server.tool.call',
        type: 'mcp',
        resource: 'renamed-tool',
        meta: {
          component: 'modelcontextprotocol_server_tool',
          '_dd.integration': 'modelcontextprotocol_server_tool',
          'span.kind': 'internal',
        },
      })

      testSetup.renameTestTool('renamed-tool')
      try {
        await testSetup.clientCallTool('renamed-tool')
      } finally {
        testSetup.renameTestTool('test-tool')
      }

      return traceAssertion
    })
  })
})
