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

      before(async () => {
        const serverModule = require(`../../../../../../versions/@modelcontextprotocol/server@${version}`).get()
        const clientModule = require('../../../../../../versions/@modelcontextprotocol/client@2').get()

        server = new serverModule.McpServer({ name: 'test-server', version: '1.0.0' })
        // A strict schema rejects arguments it does not declare, so the tool only succeeds without `telemetry`.
        const inputSchema = serverModule.fromJsonSchema({
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        })
        server.registerTool('weather', { description: 'Weather for a city', inputSchema }, async args => {
          receivedArguments = args
          return TOOL_RESULT
        })
        server.registerTool('ui-only', {
          description: 'Only the app calls this tool',
          inputSchema: {},
          _meta: { ui: { visibility: ['app'] } },
        }, async () => TOOL_RESULT)

        const [clientTransport, serverTransport] = serverModule.InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        client = new clientModule.Client({ name: 'test-client', version: '1.0.0' })
        await client.connect(clientTransport)
      })

      after(async () => {
        await client?.close()
        await server?.close()
      })

      it('adds a required telemetry argument to model-callable tools in tools/list', async () => {
        const first = await client.listTools()
        const second = await client.listTools()

        for (const result of [first, second]) {
          assertTelemetryArgument(result.tools.find(tool => tool.name === 'weather'))
          assert.equal(result.tools.find(tool => tool.name === 'ui-only').inputSchema.properties?.telemetry, undefined)
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
    })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', version => {
      let client
      let server

      before(async () => {
        const versionModule = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
        const { Client } = versionModule.get('@modelcontextprotocol/sdk/client')
        const clientEntryPath = versionModule.getPath('@modelcontextprotocol/sdk/client')
        const sdkDir = path.resolve(path.dirname(clientEntryPath), '..', '..', '..')
        const { McpServer } = require(path.join(sdkDir, 'dist/cjs/server/mcp.js'))
        const { InMemoryTransport } = versionModule.get('@modelcontextprotocol/sdk/inMemory.js')

        server = new McpServer({ name: 'test-server', version: '1.0.0' })
        server.registerTool('weather', { description: 'Weather', inputSchema: {} }, async () => TOOL_RESULT)

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        client = new Client({ name: 'test-client', version: '1.0.0' })
        await client.connect(clientTransport)
      })

      after(async () => {
        await client?.close()
        await server?.close()
      })

      it('adds a required telemetry argument to tools/list', async () => {
        const result = await client.listTools()

        assertTelemetryArgument(result.tools[0])

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
    })
  })
})
