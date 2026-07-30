'use strict'

const assert = require('node:assert')
const { inspect } = require('node:util')
const { describe, it, before, after } = require('mocha')
const { withVersions } = require('../../../setup/mocha')

const agent = require('../../../plugins/agent')
const {
  assertLlmObsSpanEvent,
  MOCK_STRING,
  useLlmObs,
} = require('../../util')

function findSpanByToolName (spans, spanName, toolName) {
  return spans.find(span => {
    if (span.name !== spanName) return false
    if (span.name === toolName || span.name === `MCP Client Tool Call: ${toolName}`) return true

    try {
      const input = JSON.parse(span.meta.input.value)
      return input.name === toolName || input.params?.name === toolName
    } catch {
      return false
    }
  })
}

function findApmSpanForLlmObsSpan (apmSpans, llmobsSpan) {
  return apmSpans.find(span => span.span_id.toString() === llmobsSpan.span_id)
}

describe('integrations', () => {
  let Client
  let McpServer
  let InMemoryTransport
  let EmptyResultSchema
  let ListResourceTemplatesRequestSchema

  let client
  let server

  describe('modelcontextprotocol-sdk', () => {
    const { getEvents } = useLlmObs({ plugin: 'modelcontextprotocol-sdk' })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', (version) => {
      before(async () => {
        const versionModule = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)

        // Require the client submodule first so RITM patches it before the server loads it transitively
        Client = versionModule.get('@modelcontextprotocol/sdk/client').Client
        McpServer = versionModule.get('@modelcontextprotocol/sdk/server/mcp.js').McpServer
        InMemoryTransport = versionModule.get('@modelcontextprotocol/sdk/inMemory.js').InMemoryTransport
        const types = versionModule.get('@modelcontextprotocol/sdk/types.js')
        EmptyResultSchema = types.EmptyResultSchema
        ListResourceTemplatesRequestSchema = types.ListResourceTemplatesRequestSchema

        server = new McpServer({ name: 'test-server', version: '1.0.0' })

        server.registerTool(
          'test-tool',
          { description: 'A test tool', inputSchema: {} },
          async () => ({
            content: [{ type: 'text', text: 'Result from test-tool' }],
          })
        )

        server.registerTool(
          'error-tool',
          { description: 'A tool that errors', inputSchema: {} },
          async () => {
            throw new Error('Intentional test error')
          }
        )

        server.registerTool(
          'multi-content-tool',
          { description: 'Returns multiple content parts', inputSchema: {} },
          async () => ({
            content: [
              { type: 'text', text: 'First part' },
              { type: 'text', text: 'Second part' },
            ],
          })
        )

        server.registerResource(
          'test-resource',
          'file:///test-resource.txt',
          { description: 'A test resource', mimeType: 'text/plain' },
          async () => ({
            contents: [{ uri: 'file:///test-resource.txt', text: 'resource content' }],
          })
        )

        server.registerPrompt(
          'test-prompt',
          { description: 'A test prompt', argsSchema: {} },
          async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'test prompt message' } }],
          })
        )

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)

        client = new Client({ name: 'test-client', version: '1.0.0' })
        await client.connect(clientTransport)

        // The MCP handshake (client.connect) triggers server-side request spans.
        // Drain them now so they do not bleed into the first test.
        // Flush interval is 0 — wait a few ticks for the writer to send them.
        for (let i = 0; i < 50; i++) {
          await new Promise(resolve => setImmediate(resolve))
          agent.getLlmObsSpanEventsRequests(true)
        }
      })

      after(async () => {
        if (client) await client.close()
        if (server) await server.close()
      })

      describe('Client.callTool', () => {
        // client.callTool produces 2 LLMObs spans per call:
        //   [0] client tool call  (starts first — initiated by the caller)
        //   [1] server tool call  (starts when server receives the message)
        it('creates a tool span for a basic tool call', async () => {
          const result = await client.callTool({ name: 'test-tool', arguments: {} })

          assert.ok(result.content)
          assert.equal(result.content[0].text, 'Result from test-tool')

          const { apmSpans, llmobsSpans } = await getEvents(2)

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'tool',
            name: 'MCP Client Tool Call: test-tool',
            inputValue: JSON.stringify({}),
            outputValue: JSON.stringify({
              content: [{ type: 'text', text: 'Result from test-tool', annotations: {}, meta: {} }],
              isError: false,
            }),
            tags: {
              ml_app: 'test',
              integration: 'modelcontextprotocol-sdk',
              mcp_tool_kind: 'client',
              mcp_server_name: 'test-server',
            },
          })
        })

        it('creates a tool span with arguments', async () => {
          const result = await client.callTool({
            name: 'test-tool',
            arguments: { query: 'hello world', limit: 10 },
          })

          assert.ok(result.content)

          const { apmSpans, llmobsSpans } = await getEvents(2)

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'tool',
            name: 'MCP Client Tool Call: test-tool',
            inputValue: JSON.stringify({
              query: 'hello world',
              limit: 10,
            }),
            outputValue: JSON.stringify({
              content: [{ type: 'text', text: 'Result from test-tool', annotations: {}, meta: {} }],
              isError: false,
            }),
            tags: {
              ml_app: 'test',
              integration: 'modelcontextprotocol-sdk',
              mcp_tool_kind: 'client',
              mcp_server_name: 'test-server',
            },
          })
        })

        it('creates a tool span with multi-content response', async () => {
          const result = await client.callTool({ name: 'multi-content-tool', arguments: {} })

          assert.ok(result.content)
          assert.equal(result.content.length, 2)

          const { apmSpans, llmobsSpans } = await getEvents(2)

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'tool',
            name: 'MCP Client Tool Call: multi-content-tool',
            inputValue: JSON.stringify({}),
            outputValue: JSON.stringify({
              content: [
                { type: 'text', text: 'First part', annotations: {}, meta: {} },
                { type: 'text', text: 'Second part', annotations: {}, meta: {} },
              ],
              isError: false,
            }),
            tags: {
              ml_app: 'test',
              integration: 'modelcontextprotocol-sdk',
              mcp_tool_kind: 'client',
              mcp_server_name: 'test-server',
            },
          })
        })

        it('creates a tool span with error on failure', async () => {
          // In MCP SDK 1.27+, tool errors are returned as isError:true results, not thrown exceptions
          const result = await client.callTool({ name: 'error-tool', arguments: {} })
          assert.ok(result.isError, 'callTool result should have isError: true')
          assert.ok(
            result.content?.[0]?.text?.includes('Intentional test error'),
            `Got: ${inspect(result.content?.[0]?.text)}`
          )

          const { apmSpans, llmobsSpans } = await getEvents(2)

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'tool',
            name: 'MCP Client Tool Call: error-tool',
            inputValue: JSON.stringify({}),
            outputValue: JSON.stringify({
              content: [{
                type: 'text',
                text: result.content[0].text,
                annotations: {},
                meta: {},
              }],
              isError: true,
            }),
            error: {
              type: MOCK_STRING,
              message: MOCK_STRING,
            },
            tags: {
              ml_app: 'test',
              integration: 'modelcontextprotocol-sdk',
              mcp_tool_kind: 'client',
              mcp_server_name: 'test-server',
            },
          })
        })
      })

      describe('Client.connect', () => {
        it('creates client and server initialize spans', async () => {
          let initializeClient
          let initializeServer

          try {
            initializeServer = new McpServer({ name: 'initialize-server', version: '2.0.0' })

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
            await initializeServer.connect(serverTransport)

            initializeClient = new Client({ name: 'initialize-client', version: '1.2.3' })
            await initializeClient.connect(clientTransport)

            const { apmSpans, llmobsSpans } = await getEvents(2)
            const clientInitialize = llmobsSpans.find(span => span.name === 'MCP Client Initialize')
            const serverInitialize = llmobsSpans.find(span => span.name === 'mcp.initialize')

            assert.ok(clientInitialize)
            assert.ok(serverInitialize)

            const clientInitializeApm = findApmSpanForLlmObsSpan(apmSpans, clientInitialize)
            const serverInitializeApm = findApmSpanForLlmObsSpan(apmSpans, serverInitialize)
            const clientInitializeOutputValue = clientInitialize.meta.output.value
            const serverInitializeOutputValue = serverInitialize.meta.output.value

            assertLlmObsSpanEvent(clientInitialize, {
              span: clientInitializeApm,
              spanKind: 'task',
              name: 'MCP Client Initialize',
              outputValue: clientInitializeOutputValue,
              tags: { ml_app: 'test', integration: 'modelcontextprotocol-sdk' },
            })

            const clientOutput = JSON.parse(clientInitializeOutputValue)
            assert.strictEqual(clientOutput.serverInfo.name, 'initialize-server')
            assert.strictEqual(clientOutput.serverInfo.version, '2.0.0')

            assertLlmObsSpanEvent(serverInitialize, {
              span: serverInitializeApm,
              parentId: clientInitializeApm.span_id,
              spanKind: 'task',
              name: 'mcp.initialize',
              inputValue: serverInitialize.meta.input.value,
              outputValue: serverInitializeOutputValue,
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_method: 'initialize',
                client_name: 'initialize-client',
                client_version: 'initialize-client_1.2.3',
              },
            })

            const input = JSON.parse(serverInitialize.meta.input.value)
            assert.strictEqual(input.method, 'initialize')
            assert.strictEqual(input.params.clientInfo.name, 'initialize-client')
            assert.strictEqual(input.params.clientInfo.version, '1.2.3')
            assert.strictEqual(input.params._meta, undefined)

            const serverOutput = JSON.parse(serverInitializeOutputValue)
            assert.strictEqual(serverOutput.serverInfo.name, 'initialize-server')
            assert.strictEqual(serverOutput.serverInfo.version, '2.0.0')
          } finally {
            if (initializeClient) await initializeClient.close()
            if (initializeServer) await initializeServer.close()
          }
        })
      })

      describe('Client.listTools', () => {
        // client.listTools produces 2 LLMObs spans per call:
        //   [0] client list tools  (starts first)
        //   [1] server request     (starts when server receives the message)
        it('creates a task span for listing tools', async () => {
          const result = await client.listTools()

          assert.ok(result.tools)
          assert.equal(result.tools.length, 3)

          const { apmSpans, llmobsSpans } = await getEvents(2)

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'task',
            name: 'MCP Client list Tools',
            inputValue: JSON.stringify({ cursor: null }),
            outputValue: JSON.stringify(result),
            tags: { ml_app: 'test', integration: 'modelcontextprotocol-sdk' },
          })
        })
      })

      describe('McpServer (server-side)', () => {
        describe('McpServerRequestLLMObsPlugin', () => {
          it('restores the parent after dispatching concurrent server requests', async () => {
            const slowToolName = 'slow-parent-restore-tool'
            let releaseSlowTool
            let resolveSlowToolStarted
            const slowToolStarted = new Promise(resolve => {
              resolveSlowToolStarted = resolve
            })

            server.registerTool(
              slowToolName,
              { description: 'A slow tool', inputSchema: {} },
              async () => {
                const waitForRelease = new Promise(resolve => {
                  releaseSlowTool = resolve
                })
                resolveSlowToolStarted()
                await waitForRelease

                return {
                  content: [{ type: 'text', text: 'Slow result' }],
                }
              }
            )

            const slowCall = client.callTool({ name: slowToolName, arguments: {} })
            await slowToolStarted

            await client.callTool({ name: 'test-tool', arguments: {} })
            releaseSlowTool()
            await slowCall

            const { llmobsSpans } = await getEvents(4)

            const slowClient = findSpanByToolName(
              llmobsSpans,
              'MCP Client Tool Call: slow-parent-restore-tool',
              slowToolName
            )
            const slowRequest = findSpanByToolName(llmobsSpans, slowToolName, slowToolName)
            const fastClient = findSpanByToolName(llmobsSpans, 'MCP Client Tool Call: test-tool', 'test-tool')
            const fastRequest = findSpanByToolName(llmobsSpans, 'test-tool', 'test-tool')

            assert.ok(slowClient)
            assert.ok(slowRequest)
            assert.ok(fastClient)
            assert.ok(fastRequest)

            assert.strictEqual(slowClient.parent_id, 'undefined')
            assert.strictEqual(fastClient.parent_id, 'undefined')
            assert.strictEqual(slowRequest.parent_id, slowClient.span_id)
            assert.strictEqual(fastRequest.parent_id, fastClient.span_id)
          })

          it('creates a tool span for a tools/call server request', async () => {
            const result = await client.callTool({ name: 'test-tool', arguments: {} })

            const { apmSpans, llmobsSpans } = await getEvents(2)
            const inputValue = llmobsSpans[1].meta.input.value

            // llmobsSpans sorted by start_ns: [0]=client tool call, [1]=server tool call on the server request span.
            // The server tool LLMObs span is a child of the client tool call span (in-memory transport
            // executes synchronously in the same async context).
            assertLlmObsSpanEvent(llmobsSpans[1], {
              span: apmSpans[1],
              parentId: apmSpans[0].span_id,
              spanKind: 'tool',
              name: 'test-tool',
              inputValue,
              outputValue: JSON.stringify(result),
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_method: 'tools/call',
                mcp_tool: 'test-tool',
                mcp_tool_kind: 'server',
              },
            })

            const input = JSON.parse(inputValue)
            assert.strictEqual(input.method, 'tools/call')
            assert.deepStrictEqual(input.params, { name: 'test-tool', arguments: {} })
            assert.strictEqual(input.params._meta, undefined)
          })

          it('tags server request spans with transport session id', async () => {
            let sessionClient
            let sessionServer

            try {
              sessionServer = new McpServer({ name: 'session-server', version: '1.0.0' })
              sessionServer.registerTool(
                'session-tool',
                { description: 'A session tool', inputSchema: {} },
                async () => ({ content: [{ type: 'text', text: 'session result' }] })
              )

              const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
              serverTransport.sessionId = 'session-123'
              await sessionServer.connect(serverTransport)

              sessionClient = new Client({ name: 'session-client', version: '1.0.0' })
              await sessionClient.connect(clientTransport)

              // Drain the initialize spans from both APM and LLMObs before asserting the tool call.
              await getEvents(2)

              const result = await sessionClient.callTool({ name: 'session-tool', arguments: {} })
              const { apmSpans, llmobsSpans } = await getEvents(2)
              const clientTool = findSpanByToolName(
                llmobsSpans,
                'MCP Client Tool Call: session-tool',
                'session-tool'
              )
              const serverTool = findSpanByToolName(llmobsSpans, 'session-tool', 'session-tool')

              assert.ok(clientTool)
              assert.ok(serverTool)

              const clientApmSpan = findApmSpanForLlmObsSpan(apmSpans, clientTool)
              const serverApmSpan = findApmSpanForLlmObsSpan(apmSpans, serverTool)

              assert.ok(clientApmSpan)
              assert.ok(serverApmSpan)

              assertLlmObsSpanEvent(serverTool, {
                span: serverApmSpan,
                parentId: clientApmSpan.span_id,
                spanKind: 'tool',
                name: 'session-tool',
                inputValue: serverTool.meta.input.value,
                outputValue: JSON.stringify(result),
                tags: {
                  ml_app: 'test',
                  integration: 'modelcontextprotocol-sdk',
                  mcp_method: 'tools/call',
                  mcp_tool: 'session-tool',
                  mcp_tool_kind: 'server',
                  mcp_session_id: 'session-123',
                },
              })
            } finally {
              if (sessionClient) await sessionClient.close()
              if (sessionServer) await sessionServer.close()
            }
          })

          it('creates a tool span for a tools/call server request with arguments', async () => {
            const result = await client.callTool({
              name: 'test-tool',
              arguments: { query: 'hello world', limit: 10 },
            })

            const { apmSpans, llmobsSpans } = await getEvents(2)
            const inputValue = llmobsSpans[1].meta.input.value

            assertLlmObsSpanEvent(llmobsSpans[1], {
              span: apmSpans[1],
              parentId: apmSpans[0].span_id,
              spanKind: 'tool',
              name: 'test-tool',
              inputValue,
              outputValue: JSON.stringify(result),
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_method: 'tools/call',
                mcp_tool: 'test-tool',
                mcp_tool_kind: 'server',
              },
            })

            const input = JSON.parse(inputValue)
            assert.strictEqual(input.method, 'tools/call')
            assert.deepStrictEqual(input.params, {
              name: 'test-tool',
              arguments: { query: 'hello world', limit: 10 },
            })
          })

          it('creates a tool span with error for a tools/call server request error', async () => {
            const result = await client.callTool({ name: 'error-tool', arguments: {} })
            assert.ok(result.isError)

            const { apmSpans, llmobsSpans } = await getEvents(2)
            const inputValue = llmobsSpans[1].meta.input.value

            assertLlmObsSpanEvent(llmobsSpans[1], {
              span: apmSpans[1],
              parentId: apmSpans[0].span_id,
              spanKind: 'tool',
              name: 'error-tool',
              inputValue,
              outputValue: JSON.stringify(result),
              error: {
                type: MOCK_STRING,
                message: MOCK_STRING,
              },
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_method: 'tools/call',
                mcp_tool: 'error-tool',
                mcp_tool_kind: 'server',
              },
            })
          })

          it('creates a task span for a tools/list server request', async () => {
            await client.listTools()

            const { apmSpans, llmobsSpans } = await getEvents(2)
            const inputValue = llmobsSpans[1].meta.input.value
            const outputValue = llmobsSpans[1].meta.output.value

            // llmobsSpans sorted by start_ns: [0]=client list tools, [1]=server request
            assertLlmObsSpanEvent(llmobsSpans[1], {
              span: apmSpans[1],
              parentId: apmSpans[0].span_id,
              spanKind: 'task',
              name: 'MCP Server Request: tools/list',
              inputValue,
              outputValue,
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_method: 'tools/list',
              },
            })

            const input = JSON.parse(inputValue)
            assert.strictEqual(input.method, 'tools/list')

            const output = JSON.parse(outputValue)
            assert.ok(output.tools)
            assert.ok(output.tools.some(tool => tool.name === 'test-tool'))
          })

          it('creates a task span for a resources/list server request', async () => {
            await client.listResources()

            const { apmSpans, llmobsSpans } = await getEvents(1)
            const serverRequest = llmobsSpans.find(span => span.name === 'MCP Server Request: resources/list')
            const outputValue = serverRequest?.meta.output.value

            assert.ok(serverRequest)

            const serverApmSpan = findApmSpanForLlmObsSpan(apmSpans, serverRequest)
            assert.ok(serverApmSpan)

            assertLlmObsSpanEvent(serverRequest, {
              span: serverApmSpan,
              spanKind: 'task',
              name: 'MCP Server Request: resources/list',
              inputValue: serverRequest.meta.input.value,
              outputValue,
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_method: 'resources/list',
              },
            })

            const input = JSON.parse(serverRequest.meta.input.value)
            assert.strictEqual(input.method, 'resources/list')
            assert.strictEqual(input.params?._meta, undefined)

            const output = JSON.parse(outputValue)
            assert.ok(output.resources.some(resource => resource.uri === 'file:///test-resource.txt'))
          })

          it('creates a task span for a resources/read server request', async () => {
            await client.readResource({ uri: 'file:///test-resource.txt' })

            const { apmSpans, llmobsSpans } = await getEvents(1)
            const serverRequest = llmobsSpans.find(span => span.name === 'MCP Server Request: resources/read')
            const outputValue = serverRequest?.meta.output.value

            assert.ok(serverRequest)

            const serverApmSpan = findApmSpanForLlmObsSpan(apmSpans, serverRequest)
            assert.ok(serverApmSpan)

            assertLlmObsSpanEvent(serverRequest, {
              span: serverApmSpan,
              spanKind: 'task',
              name: 'MCP Server Request: resources/read',
              inputValue: serverRequest.meta.input.value,
              outputValue,
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_method: 'resources/read',
              },
            })

            const input = JSON.parse(serverRequest.meta.input.value)
            assert.strictEqual(input.method, 'resources/read')
            assert.strictEqual(input.params.uri, 'file:///test-resource.txt')
            assert.strictEqual(input.params._meta, undefined)

            const output = JSON.parse(outputValue)
            assert.strictEqual(output.contents[0].uri, 'file:///test-resource.txt')
            assert.strictEqual(output.contents[0].text, 'resource content')
          })

          it('creates a task span for a prompts/list server request', async () => {
            await client.listPrompts()

            const { apmSpans, llmobsSpans } = await getEvents(1)
            const serverRequest = llmobsSpans.find(span => span.name === 'MCP Server Request: prompts/list')
            const outputValue = serverRequest?.meta.output.value

            assert.ok(serverRequest)

            const serverApmSpan = findApmSpanForLlmObsSpan(apmSpans, serverRequest)
            assert.ok(serverApmSpan)

            assertLlmObsSpanEvent(serverRequest, {
              span: serverApmSpan,
              spanKind: 'task',
              name: 'MCP Server Request: prompts/list',
              inputValue: serverRequest.meta.input.value,
              outputValue,
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_method: 'prompts/list',
              },
            })

            const input = JSON.parse(serverRequest.meta.input.value)
            assert.strictEqual(input.method, 'prompts/list')
            assert.strictEqual(input.params?._meta, undefined)

            const output = JSON.parse(outputValue)
            assert.ok(output.prompts.some(prompt => prompt.name === 'test-prompt'))
          })

          it('creates a task span for a prompts/get server request', async () => {
            await client.getPrompt({ name: 'test-prompt', arguments: {} })

            const { apmSpans, llmobsSpans } = await getEvents(1)
            const serverRequest = llmobsSpans.find(span => span.name === 'MCP Server Request: prompts/get')
            const outputValue = serverRequest?.meta.output.value

            assert.ok(serverRequest)

            const serverApmSpan = findApmSpanForLlmObsSpan(apmSpans, serverRequest)
            assert.ok(serverApmSpan)

            assertLlmObsSpanEvent(serverRequest, {
              span: serverApmSpan,
              spanKind: 'task',
              name: 'MCP Server Request: prompts/get',
              inputValue: serverRequest.meta.input.value,
              outputValue,
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_method: 'prompts/get',
              },
            })

            const input = JSON.parse(serverRequest.meta.input.value)
            assert.strictEqual(input.method, 'prompts/get')
            assert.strictEqual(input.params.name, 'test-prompt')
            assert.strictEqual(input.params._meta, undefined)

            const output = JSON.parse(outputValue)
            assert.strictEqual(output.messages[0].content.text, 'test prompt message')
          })

          it('creates an error span when tools/call validation fails', async () => {
            await assert.rejects(
              () => client.request({ method: 'tools/call', params: { arguments: {} } }, EmptyResultSchema),
              { message: /expected string/ }
            )

            const { apmSpans, llmobsSpans } = await getEvents(1)
            const serverTool = llmobsSpans.find(span => span.name === 'unknown_tool')

            assert.ok(serverTool)

            const serverApmSpan = findApmSpanForLlmObsSpan(apmSpans, serverTool)
            assert.ok(serverApmSpan)

            assertLlmObsSpanEvent(serverTool, {
              span: serverApmSpan,
              spanKind: 'tool',
              name: 'unknown_tool',
              inputValue: serverTool.meta.input.value,
              error: {
                type: MOCK_STRING,
                message: MOCK_STRING,
              },
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_method: 'tools/call',
                mcp_tool: 'unknown_tool',
                mcp_tool_kind: 'server',
              },
            })
          })

          it('creates an error span when a custom server handler rejects', async () => {
            server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
              throw new Error('template handler failed')
            })

            await assert.rejects(
              () => client.listResourceTemplates(),
              { message: /template handler failed/ }
            )

            const { apmSpans, llmobsSpans } = await getEvents(1)
            const serverRequest = llmobsSpans.find(span => {
              return span.name === 'MCP Server Request: resources/templates/list'
            })

            assert.ok(serverRequest)

            const serverApmSpan = findApmSpanForLlmObsSpan(apmSpans, serverRequest)
            assert.ok(serverApmSpan)

            assertLlmObsSpanEvent(serverRequest, {
              span: serverApmSpan,
              spanKind: 'task',
              name: 'MCP Server Request: resources/templates/list',
              inputValue: serverRequest.meta.input.value,
              error: {
                type: MOCK_STRING,
                message: MOCK_STRING,
              },
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_method: 'resources/templates/list',
              },
            })
          })

          it('creates an error span for allowlisted unknown methods', async () => {
            try {
              await client.request({ method: 'tools/unknown' }, EmptyResultSchema)
            } catch {
              // Expected: the server returns MethodNotFound.
            }

            const { apmSpans, llmobsSpans } = await getEvents(1)
            const serverRequest = llmobsSpans.find(span => span.name === 'MCP Server Request: tools/unknown')

            assert.ok(serverRequest)

            const serverApmSpan = findApmSpanForLlmObsSpan(apmSpans, serverRequest)
            assert.ok(serverApmSpan)

            assertLlmObsSpanEvent(serverRequest, {
              span: serverApmSpan,
              spanKind: 'task',
              name: 'MCP Server Request: tools/unknown',
              inputValue: serverRequest.meta.input.value,
              error: {
                type: MOCK_STRING,
                message: MOCK_STRING,
              },
              tags: {
                ml_app: 'test',
                integration: 'modelcontextprotocol-sdk',
                mcp_method: 'tools/unknown',
              },
            })
          })
        })
      })
    })
  })
})
