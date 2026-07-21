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
    return s.name === 'mcp.request' && s.resource === clientResource
  })
  const serverSpan = spans.find(s => {
    return s.name === 'mcp.request' && s.resource === 'server_tool_call'
  })

  assert.ok(clientSpan, 'client tool call span should exist')
  assert.ok(serverSpan, 'server tool call request span should exist')
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

function assertSpanDoesNotHaveTags (span, tagNames) {
  const meta = span.meta || {}
  const metrics = span.metrics || {}

  for (const tagName of tagNames) {
    assert.strictEqual(Object.hasOwn(meta, tagName), false, `${tagName} should not be set as span meta`)
    assert.strictEqual(Object.hasOwn(metrics, tagName), false, `${tagName} should not be set as span metric`)
  }
}

function expectServerRequestWithoutTags (agent, resource, tagNames) {
  return agent.assertSomeTraces(traces => {
    const spans = traces.flatMap(trace => trace)
    const span = spans.find(span => {
      return span.name === 'mcp.request' && span.resource === resource
    })

    assert.ok(span, `mcp.request span should exist for ${resource}`)
    assertSpanDoesNotHaveTags(span, tagNames)
  })
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

  describe('Client.callTool() - mcp.request', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.request',
        type: 'mcp',
        resource: 'client_tool_call',
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
        name: 'mcp.request',
        type: 'mcp',
        resource: 'client_tool_call',
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

  describe('Client.listTools() - mcp.request', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.request',
        type: 'mcp',
        resource: 'ClientSession.list_tools',
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
    it('should generate span with operation as resource tag', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.resource.read',
        type: 'mcp',
        resource: 'resources/read',
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
    it('should generate span with operation as resource tag', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.prompt.get',
        type: 'mcp',
        resource: 'prompts/get',
        meta: { component: 'modelcontextprotocol_get_prompt', 'span.kind': 'client' },
      })
      await testSetup.clientGetPrompt()
      return traceAssertion
    })
  })

  describe('Protocol.setRequestHandler - mcp.request', () => {
    it('should not tag tool request arguments or response shape on tools/call', async () => {
      const traceAssertion = expectServerRequestWithoutTags(agent, 'server_tool_call', [
        'mcp.tool.name',
        'mcp.request.argument_keys',
        'mcp.request.argument_count',
        'mcp.request.arguments',
        'mcp.tool.response',
        'mcp.tool.response.content_count',
        'mcp.tool.response.content_types',
      ])

      await testSetup.clientCallTool()

      return traceAssertion
    })

    it('should not tag tool inventories on tools/list', async () => {
      const traceAssertion = expectServerRequestWithoutTags(agent, 'tools/list', ['mcp.tool.names'])

      await testSetup.clientListTools()

      return traceAssertion
    })

    it('should not tag resource URI on resources/read', async () => {
      const traceAssertion = expectServerRequestWithoutTags(agent, 'resources/read', ['mcp.resource.uri'])

      await testSetup.clientReadResource()

      return traceAssertion
    })

    it('should not tag resource inventories on resources/list', async () => {
      const traceAssertion = expectServerRequestWithoutTags(agent, 'resources/list', ['mcp.resource.uris'])

      await testSetup.clientListResources()

      return traceAssertion
    })

    it('should not tag prompt name on prompts/get', async () => {
      const traceAssertion = expectServerRequestWithoutTags(agent, 'prompts/get', ['mcp.prompt.name'])

      await testSetup.clientGetPrompt()

      return traceAssertion
    })

    it('should not tag prompt inventories on prompts/list', async () => {
      const traceAssertion = expectServerRequestWithoutTags(agent, 'prompts/list', [
        'mcp.prompt.names',
        'mcp.prompt.descriptions',
      ])

      await testSetup.clientListPrompts()

      return traceAssertion
    })

    it('should generate server request span with error when tools/call returns isError', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.request',
        type: 'mcp',
        resource: 'server_tool_call',
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
        name: 'mcp.request',
        type: 'mcp',
        resource: 'server_tool_call',
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
        name: 'mcp.request',
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

    it('should finish server request spans with error for allowlisted unknown methods', async () => {
      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.request',
        type: 'mcp',
        resource: 'tools/unknown',
        error: 1,
        meta: {
          component: 'modelcontextprotocol_server',
          '_dd.integration': 'modelcontextprotocol_server',
          'span.kind': 'server',
          'error.message': 'Method not found',
          'error.type': 'McpError',
        },
      })

      await testSetup.clientSendUnknownMethod()

      return traceAssertion
    })
  })

  describe('context propagation', () => {
    it('server tool call request span should be a child of client tool call span', async () => {
      // Client and server run in the same process via InMemoryTransport, so async
      // context propagation carries the client span into the server _onrequest handler.
      // Distributed extraction can split linked spans across trace payloads, so aggregate
      // the mock agent payloads before asserting the relationship.
      const spans = []
      const traceAssertion = agent.assertSomeTraces(traces => {
        spans.push(...traces.flatMap(trace => trace))
        assertClientServerParenting(spans, 'client_tool_call')
      })

      await testSetup.clientCallTool()

      return traceAssertion
    })

    it('server tool call request span should use _meta trace context when async context is absent', async () => {
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
        assertClientServerParenting(spans, 'client_tool_call')
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
      let markSlowToolStarted
      const slowToolStarted = new Promise(resolve => { markSlowToolStarted = resolve })

      disconnectServer.registerTool(
        'slow-tool',
        { description: 'Slow tool', inputSchema: {} },
        async () => {
          markSlowToolStarted()
          await holdPromise
          return { content: [{ type: 'text', text: 'done' }] }
        }
      )

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await disconnectServer.connect(serverTransport)

      const disconnectClient = new Client({ name: 'disconnect-client', version: '1.0.0' })
      await disconnectClient.connect(clientTransport)

      const traceAssertion = expectSomeSpan(agent, {
        name: 'mcp.request',
        type: 'mcp',
        resource: 'server_tool_call',
        meta: {
          component: 'modelcontextprotocol_server',
          '_dd.integration': 'modelcontextprotocol_server',
          'span.kind': 'server',
        },
      })

      // Fire the request without awaiting — it will block until holdPromise resolves.
      const callPromise = disconnectClient.callTool({ name: 'slow-tool', arguments: {} }).catch(() => {})

      await slowToolStarted

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
