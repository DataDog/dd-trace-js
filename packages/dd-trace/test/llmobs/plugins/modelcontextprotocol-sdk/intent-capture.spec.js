'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it, before, after } = require('mocha')

const { useEnv } = require('../../../../../../integration-tests/helpers')
const { withVersions } = require('../../../setup/mocha')
const { assertLlmObsSpanEvent, MOCK_STRING, useLlmObs } = require('../../util')

const TAGS = { ml_app: 'test', integration: 'modelcontextprotocol-sdk' }
const INTENT = 'Check the weather to plan a trip'
const TOOL_RESULT = { content: [{ type: 'text', text: 'sunny' }] }
const APP_ARGUMENTS = { telemetry: { intent: 'daily' } }

/**
 * @param {string} tool
 */
function serverToolTags (tool) {
  return {
    ...TAGS,
    mcp_method: 'tools/call',
    mcp_tool: tool,
    mcp_tool_kind: 'server',
    mcp_client_name: 'test-client',
    mcp_client_version: '1.0.0',
  }
}

/**
 * @param {{ inputSchema?: { properties?: object, required?: string[] } }} tool
 */
function assertTelemetryArgument (tool) {
  assert.deepStrictEqual(tool.inputSchema.properties.telemetry.required, ['intent'])
  assert.equal(tool.inputSchema.properties.telemetry.properties.intent.type, 'string')
  assert.equal(tool.inputSchema.required.filter(name => name === 'telemetry').length, 1)
}

/**
 * @param {{ apmSpans: Array<{ resource: string }>, llmobsSpans: Array<{ name: string, span_id: string,
 *   meta: { input: { value: string } } }> }} events
 * @param {string} tool
 */
function findServerToolSpan ({ apmSpans, llmobsSpans }, tool) {
  const llmobsSpan = llmobsSpans.find(span => span.name === tool)
  return {
    llmobsSpan,
    apmSpan: apmSpans.find(span => span.resource === 'server_tool_call'),
    parentId: llmobsSpans.find(span => span.name === `MCP Client Tool Call: ${tool}`).span_id,
    id: JSON.parse(llmobsSpan.meta.input.value).id,
  }
}

describe('integrations', () => {
  describe('modelcontextprotocol-sdk intent capture', () => {
    useEnv({ DD_MCP_CAPTURE_INTENT: 'true' })
    const { getEvents } = useLlmObs({ plugin: 'modelcontextprotocol-sdk' })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/server', '>=2', version => {
      let client
      let server
      let receivedArguments
      let weatherTool
      let telemetrySchema

      before(async () => {
        const serverVersion = require(`../../../../../../versions/@modelcontextprotocol/server@${version}`)
        const serverModule = serverVersion.get()
        const clientModule = require('../../../../../../versions/@modelcontextprotocol/client@2').get()
        const zod = serverVersion.get('zod/v4')

        server = new serverModule.McpServer({ name: 'test-server', version: '1.0.0' })
        // A strict schema rejects arguments it does not declare, so the tool only succeeds without `telemetry`.
        const inputSchema = serverModule.fromJsonSchema({
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        })
        weatherTool = server.registerTool('weather', { description: 'Weather for a city', inputSchema }, async args => {
          receivedArguments = args
          return TOOL_RESULT
        })
        server.registerTool('zod-weather', { inputSchema: zod.object({ city: zod.string() }) }, async args => {
          receivedArguments = args
          return TOOL_RESULT
        })
        server.registerTool('report', {
          description: 'Has its own telemetry argument',
          inputSchema: serverModule.fromJsonSchema({
            type: 'object',
            properties: { telemetry: { type: 'string' } },
            required: ['telemetry'],
            additionalProperties: false,
          }),
        }, async args => {
          receivedArguments = args
          return TOOL_RESULT
        })
        telemetrySchema = serverModule.fromJsonSchema({
          type: 'object',
          properties: {
            telemetry: { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] },
          },
          required: ['telemetry'],
        })
        server.registerTool('report-object', {
          description: 'Has its own structured telemetry argument',
          inputSchema: telemetrySchema,
        }, async args => {
          receivedArguments = args
          return TOOL_RESULT
        })
        server.registerTool('composed', {
          inputSchema: serverModule.fromJsonSchema({
            type: 'object',
            anyOf: [
              { properties: { telemetry: { type: 'object' } }, required: ['telemetry'] },
              { properties: { city: { type: 'string' } }, required: ['city'] },
            ],
          }),
        }, async args => {
          receivedArguments = args
          return TOOL_RESULT
        })
        server.registerTool('pattern', {
          inputSchema: serverModule.fromJsonSchema({
            type: 'object',
            patternProperties: { '^telemetry$': { type: 'object' } },
            additionalProperties: false,
          }),
        }, async args => {
          receivedArguments = args
          return TOOL_RESULT
        })
        server.registerTool('ui-only', {
          description: 'Only the app calls this tool',
          inputSchema: {},
          _meta: { ui: { visibility: ['app'] } },
        }, async () => TOOL_RESULT)
        server.registerTool('no-schema', {}, async () => TOOL_RESULT)

        const [clientTransport, serverTransport] = serverModule.InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        client = new clientModule.Client({ name: 'test-client', version: '1.0.0' })
        await client.connect(clientTransport)
      })

      after(async () => {
        await client?.close()
        await server?.close()
      })

      it('keeps a declared telemetry object without first listing tools', async () => {
        const result = await client.callTool({ name: 'report-object', arguments: APP_ARGUMENTS })

        assert.deepStrictEqual(result, TOOL_RESULT)
        assert.deepStrictEqual(receivedArguments, APP_ARGUMENTS)
        const { llmobsSpan } = findServerToolSpan(await getEvents(2), 'report-object')
        assert.deepStrictEqual(JSON.parse(llmobsSpan.meta.input.value).params.arguments, APP_ARGUMENTS)
        assert.equal(llmobsSpan.meta.intent, undefined)
      })

      it('adds a required telemetry argument to model-callable tools in tools/list', async () => {
        const first = await client.listTools()
        const second = await client.listTools()

        for (const result of [first, second]) {
          assertTelemetryArgument(result.tools.find(tool => tool.name === 'weather'))
          assertTelemetryArgument(result.tools.find(tool => tool.name === 'zod-weather'))
          assertTelemetryArgument(result.tools.find(tool => tool.name === 'no-schema'))
          assert.equal(result.tools.find(tool => tool.name === 'ui-only').inputSchema.properties?.telemetry, undefined)
          assert.equal(result.tools.find(tool => tool.name === 'composed').inputSchema.properties?.telemetry, undefined)
          assert.equal(result.tools.find(tool => tool.name === 'pattern').inputSchema.properties?.telemetry, undefined)
          assert.deepStrictEqual(result.tools.find(tool => tool.name === 'report').inputSchema.properties.telemetry, {
            type: 'string',
          })
        }

        const { llmobsSpans } = await getEvents(4)
        assert.deepStrictEqual(llmobsSpans.map(span => span.name).sort(), [
          'MCP Client List Tools', 'MCP Client List Tools', 'mcp.tools/list', 'mcp.tools/list',
        ])
      })

      it('records the intent and calls the tool without the telemetry argument', async () => {
        const result = await client.callTool({
          name: 'weather',
          arguments: { city: 'Paris', telemetry: { intent: INTENT } },
        })

        assert.equal(result.isError, undefined)
        assert.deepStrictEqual(receivedArguments, { city: 'Paris' })

        const { llmobsSpan, apmSpan, parentId, id } = findServerToolSpan(await getEvents(2), 'weather')
        assertLlmObsSpanEvent(llmobsSpan, {
          span: apmSpan,
          parentId,
          spanKind: 'tool',
          name: 'weather',
          intent: INTENT,
          inputValue: JSON.stringify({
            method: 'tools/call',
            params: { name: 'weather', arguments: { city: 'Paris' } },
            jsonrpc: '2.0',
            id,
          }),
          outputValue: JSON.stringify(TOOL_RESULT),
          tags: serverToolTags('weather'),
        })
      })

      it('does not record an intent for a tools/call without the telemetry argument', async () => {
        await client.callTool({ name: 'weather', arguments: { city: 'Rome' } })

        assert.deepStrictEqual(receivedArguments, { city: 'Rome' })

        const { llmobsSpan, apmSpan, parentId, id } = findServerToolSpan(await getEvents(2), 'weather')
        assertLlmObsSpanEvent(llmobsSpan, {
          span: apmSpan,
          parentId,
          spanKind: 'tool',
          name: 'weather',
          inputValue: JSON.stringify({
            method: 'tools/call',
            params: { name: 'weather', arguments: { city: 'Rome' } },
            jsonrpc: '2.0',
            id,
          }),
          outputValue: JSON.stringify(TOOL_RESULT),
          tags: serverToolTags('weather'),
        })
      })

      it('records intent for a tool without an input schema', async () => {
        const result = await client.callTool({ name: 'no-schema', arguments: { telemetry: { intent: INTENT } } })
        assert.deepStrictEqual(result, TOOL_RESULT)
        const { llmobsSpan } = findServerToolSpan(await getEvents(2), 'no-schema')
        assert.equal(llmobsSpan.meta.intent, INTENT)
      })

      it('records intent for a Zod object that strips unknown arguments', async () => {
        const result = await client.callTool({
          name: 'zod-weather',
          arguments: { city: 'Oslo', telemetry: { intent: INTENT } },
        })
        assert.deepStrictEqual(result, TOOL_RESULT)
        assert.deepStrictEqual(receivedArguments, { city: 'Oslo' })
        const { llmobsSpan } = findServerToolSpan(await getEvents(2), 'zod-weather')
        assert.equal(llmobsSpan.meta.intent, INTENT)
      })

      it('removes an empty telemetry argument', async () => {
        const result = await client.callTool({ name: 'weather', arguments: { city: 'Oslo', telemetry: {} } })

        assert.equal(result.isError, undefined)
        assert.deepStrictEqual(receivedArguments, { city: 'Oslo' })
        const { llmobsSpan } = findServerToolSpan(await getEvents(2), 'weather')
        assert.equal(llmobsSpan.meta.intent, undefined)
      })

      it('cuts a long intent', async () => {
        await client.callTool({ name: 'weather', arguments: { city: 'Oslo', telemetry: { intent: 'a'.repeat(2000) } } })

        const { llmobsSpan } = findServerToolSpan(await getEvents(2), 'weather')
        assert.equal(llmobsSpan.meta.intent, 'a'.repeat(1024))
      })

      it('keeps a telemetry argument that the tool declares', async () => {
        await client.callTool({ name: 'report', arguments: { telemetry: 'daily' } })

        assert.deepStrictEqual(receivedArguments, { telemetry: 'daily' })

        const { llmobsSpan } = findServerToolSpan(await getEvents(2), 'report')
        assert.equal(llmobsSpan.meta.intent, undefined)
      })

      it('uses the updated schema without another tools/list request', async () => {
        weatherTool.update({ paramsSchema: telemetrySchema })
        const result = await client.callTool({ name: 'weather', arguments: APP_ARGUMENTS })

        assert.deepStrictEqual(result, TOOL_RESULT)
        assert.deepStrictEqual(receivedArguments, APP_ARGUMENTS)
        const { llmobsSpan } = findServerToolSpan(await getEvents(2), 'weather')
        assert.equal(llmobsSpan.meta.intent, undefined)
      })

      it('keeps arguments accepted through a composed schema', async () => {
        const result = await client.callTool({ name: 'composed', arguments: APP_ARGUMENTS })
        assert.deepStrictEqual(result, TOOL_RESULT)
        assert.deepStrictEqual(receivedArguments, APP_ARGUMENTS)
        const { llmobsSpan } = findServerToolSpan(await getEvents(2), 'composed')
        assert.equal(llmobsSpan.meta.intent, undefined)
      })

      it('keeps telemetry matched by patternProperties', async () => {
        const result = await client.callTool({ name: 'pattern', arguments: APP_ARGUMENTS })
        assert.deepStrictEqual(result, TOOL_RESULT)
        assert.deepStrictEqual(receivedArguments, APP_ARGUMENTS)
        const { llmobsSpan } = findServerToolSpan(await getEvents(2), 'pattern')
        assert.equal(llmobsSpan.meta.intent, undefined)
      })

      it('preserves the native errors and inputs for unknown and disabled tools', async () => {
        weatherTool.disable()
        for (const [name, message] of [['weather', /Tool weather disabled/], ['missing', /Tool missing not found/]]) {
          await assert.rejects(client.callTool({ name, arguments: APP_ARGUMENTS }), { code: -32602, message })
          const { llmobsSpan } = findServerToolSpan(await getEvents(2), name)
          assert.deepStrictEqual(JSON.parse(llmobsSpan.meta.input.value).params.arguments, APP_ARGUMENTS)
          assert.equal(llmobsSpan.meta.intent, undefined)
        }
      })

      it('does not extend a replacement tools/list handler', async () => {
        const tool = { name: 'replacement', inputSchema: { type: 'object' } }
        server.server.setRequestHandler('tools/list', () => ({ tools: [tool] }))

        const result = await client.listTools()

        assert.deepStrictEqual(result.tools, [tool])
        await getEvents(2)
      })
    })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', version => {
      let client
      let server
      let receivedArguments
      let callToolRequestSchema

      before(async () => {
        const versionModule = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
        const { Client } = versionModule.get('@modelcontextprotocol/sdk/client')
        const clientEntryPath = versionModule.getPath('@modelcontextprotocol/sdk/client')
        const sdkDir = path.resolve(path.dirname(clientEntryPath), '..', '..', '..')
        const { McpServer } = require(path.join(sdkDir, 'dist/cjs/server/mcp.js'))
        const { InMemoryTransport } = versionModule.get('@modelcontextprotocol/sdk/inMemory.js')
        callToolRequestSchema = versionModule.get('@modelcontextprotocol/sdk/types.js').CallToolRequestSchema
        const zod = versionModule.get('zod')
        const zodV3 = versionModule.get('zod/v3')
        const zodV4 = versionModule.get('zod/v4')

        server = new McpServer({ name: 'test-server', version: '1.0.0' })
        server.registerTool('weather', { inputSchema: zodV3.object({}) }, async () => TOOL_RESULT)
        server.registerTool('report-object', {
          description: 'Has its own structured telemetry argument',
          inputSchema: zod.object({ telemetry: zod.object({ intent: zod.string() }) }),
        }, async args => {
          receivedArguments = args
          return TOOL_RESULT
        })
        server.registerTool('composed', {
          inputSchema: zod.union([
            zod.object({ telemetry: zod.object({ intent: zod.string() }) }),
            zod.object({ city: zod.string() }),
          ]),
        }, async args => {
          receivedArguments = args
          return TOOL_RESULT
        })
        for (const [name, inputSchema] of [
          ['catchall', zodV3.object({}).catchall(zodV3.unknown())],
          ['passthrough-v3', zodV3.object({}).passthrough()],
          ['passthrough-v4', zodV4.object({}).passthrough()],
        ]) {
          server.registerTool(name, { inputSchema }, async args => {
            receivedArguments = args
            return TOOL_RESULT
          })
        }

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        client = new Client({ name: 'test-client', version: '1.0.0' })
        await client.connect(clientTransport)
      })

      after(async () => {
        await client?.close()
        await server?.close()
      })

      it('keeps a declared telemetry object without first listing tools', async () => {
        const result = await client.callTool({ name: 'report-object', arguments: APP_ARGUMENTS })

        assert.deepStrictEqual(result, TOOL_RESULT)
        assert.deepStrictEqual(receivedArguments, APP_ARGUMENTS)
        const { llmobsSpan } = findServerToolSpan(await getEvents(2), 'report-object')
        assert.deepStrictEqual(JSON.parse(llmobsSpan.meta.input.value).params.arguments, APP_ARGUMENTS)
        assert.equal(llmobsSpan.meta.intent, undefined)
      })

      it('adds a required telemetry argument to tools/list', async () => {
        const result = await client.listTools()

        assertTelemetryArgument(result.tools[0])
        for (const name of ['composed', 'catchall', 'passthrough-v3', 'passthrough-v4']) {
          assert.equal(result.tools.find(tool => tool.name === name).inputSchema.properties?.telemetry, undefined)
        }

        const { llmobsSpans } = await getEvents(2)
        assert.deepStrictEqual(llmobsSpans.map(span => span.name).sort(), ['MCP Client List Tools', 'mcp.tools/list'])
      })

      it('records the intent and removes the telemetry argument from the tools/call input', async () => {
        await client.callTool({ name: 'weather', arguments: { telemetry: { intent: INTENT } } })

        const { llmobsSpan, apmSpan, parentId, id } = findServerToolSpan(await getEvents(2), 'weather')
        assertLlmObsSpanEvent(llmobsSpan, {
          span: apmSpan,
          parentId,
          spanKind: 'tool',
          name: 'weather',
          intent: INTENT,
          inputValue: JSON.stringify({
            method: 'tools/call',
            params: { name: 'weather', arguments: {} },
            jsonrpc: '2.0',
            id,
          }),
          outputValue: MOCK_STRING,
          tags: serverToolTags('weather'),
        })
      })

      it('keeps arguments accepted through a composed schema', async () => {
        const result = await client.callTool({ name: 'composed', arguments: APP_ARGUMENTS })
        assert.deepStrictEqual(result, TOOL_RESULT)
        assert.deepStrictEqual(receivedArguments, APP_ARGUMENTS)
        const { llmobsSpan } = findServerToolSpan(await getEvents(2), 'composed')
        assert.equal(llmobsSpan.meta.intent, undefined)
      })

      it('keeps telemetry accepted by catchall and passthrough schemas', async () => {
        for (const name of ['catchall', 'passthrough-v3', 'passthrough-v4']) {
          const result = await client.callTool({ name, arguments: APP_ARGUMENTS })
          assert.deepStrictEqual(result, TOOL_RESULT)
          assert.deepStrictEqual(receivedArguments, APP_ARGUMENTS)
          const { llmobsSpan } = findServerToolSpan(await getEvents(2), name)
          assert.equal(llmobsSpan.meta.intent, undefined)
        }
      })

      it('does not strip arguments when a custom handler replaces managed dispatch', async () => {
        server.server.setRequestHandler(callToolRequestSchema, request => {
          receivedArguments = request.params.arguments
          return TOOL_RESULT
        })
        const result = await client.callTool({ name: 'weather', arguments: APP_ARGUMENTS })

        assert.deepStrictEqual(result, TOOL_RESULT)
        assert.deepStrictEqual(receivedArguments, APP_ARGUMENTS)
        const { llmobsSpan } = findServerToolSpan(await getEvents(2), 'weather')
        assert.equal(llmobsSpan.meta.intent, undefined)
      })
    })
  })
})
