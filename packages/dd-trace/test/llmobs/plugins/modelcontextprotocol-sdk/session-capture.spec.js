'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it, before, after } = require('mocha')

const { useEnv } = require('../../../../../../integration-tests/helpers')
const { withVersions } = require('../../../setup/mocha')
const { useLlmObs } = require('../../util')

const TOOL_RESULT = { content: [{ type: 'text', text: 'sunny' }] }
const CONVERSATION_ID_PATTERN = /telemetry\.conversation_id="([0-9a-f]{32})"/

/**
 * @param {{ llmobsSpans: Array<{ name: string, session_id?: string, meta: { input: { value: string } } }> }} events
 */
function findServerToolSpan ({ llmobsSpans }) {
  return llmobsSpans.find(span => span.name === 'weather')
}

/**
 * @param {{ content: Array<{ text?: string }> }} result
 */
function getInstructedConversationId (result) {
  return result.content.at(-1).text?.match(CONVERSATION_ID_PATTERN)?.[1]
}

describe('integrations', () => {
  describe('modelcontextprotocol-sdk session capture', () => {
    useEnv({ DD_MCP_CAPTURE_SESSION: 'true' })
    const { getEvents } = useLlmObs({ plugin: 'modelcontextprotocol-sdk' })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/server', '>=2', version => {
      let serverModule
      let clientModule
      let receivedArguments

      /**
       * @param {string} [transportSessionId]
       */
      async function connect (transportSessionId) {
        const server = new serverModule.McpServer({ name: 'test-server', version: '1.0.0' })
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

        const [clientTransport, serverTransport] = serverModule.InMemoryTransport.createLinkedPair()
        if (transportSessionId) serverTransport.sessionId = transportSessionId
        await server.connect(serverTransport)
        const client = new clientModule.Client({ name: 'test-client', version: '1.0.0' })
        await client.connect(clientTransport)
        return { client, server }
      }

      before(() => {
        serverModule = require(`../../../../../../versions/@modelcontextprotocol/server@${version}`).get()
        clientModule = require('../../../../../../versions/@modelcontextprotocol/client@2').get()
      })

      describe('without a transport session', () => {
        let client
        let server

        before(async () => {
          ({ client, server } = await connect())
        })

        after(async () => {
          await client?.close()
          await server?.close()
        })

        it('adds an optional conversation_id argument to tools/list', async () => {
          const result = await client.listTools()

          const { inputSchema } = result.tools[0]
          assert.equal(inputSchema.properties.telemetry.properties.conversation_id.type, 'string')
          assert.equal(inputSchema.properties.telemetry.properties.intent, undefined)
          assert.deepStrictEqual(inputSchema.properties.telemetry.required, [])
          assert.deepStrictEqual(inputSchema.required, ['city'])

          await getEvents(2)
        })

        it('generates a session ID and asks the agent to send it back', async () => {
          const result = await client.callTool({ name: 'weather', arguments: { city: 'Paris' } })

          const conversationId = getInstructedConversationId(result)
          assert.ok(conversationId)
          assert.deepStrictEqual(result.content.slice(0, -1), TOOL_RESULT.content)
          assert.equal(findServerToolSpan(await getEvents(2)).session_id, conversationId)
        })

        it('uses the echoed conversation ID and removes the telemetry argument', async () => {
          const result = await client.callTool({
            name: 'weather',
            arguments: { city: 'Rome', telemetry: { conversation_id: 'abc' } },
          })

          assert.deepStrictEqual(result.content, TOOL_RESULT.content)
          assert.deepStrictEqual(receivedArguments, { city: 'Rome' })

          const span = findServerToolSpan(await getEvents(2))
          assert.equal(span.session_id, 'abc')
          assert.deepStrictEqual(JSON.parse(span.meta.input.value).params.arguments, { city: 'Rome' })
        })
      })

      describe('with a transport session', () => {
        let client
        let server

        before(async () => {
          ({ client, server } = await connect('transport-session'))
        })

        after(async () => {
          await client?.close()
          await server?.close()
        })

        it('keeps the result and does not set a session ID', async () => {
          const result = await client.callTool({ name: 'weather', arguments: { city: 'Oslo' } })

          assert.deepStrictEqual(result.content, TOOL_RESULT.content)
          assert.equal(findServerToolSpan(await getEvents(2)).session_id, undefined)
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

      it('generates a session ID and then uses the echoed one', async () => {
        const first = await client.callTool({ name: 'weather', arguments: {} })
        const conversationId = getInstructedConversationId(first)
        assert.ok(conversationId)
        assert.equal(findServerToolSpan(await getEvents(2)).session_id, conversationId)

        const second = await client.callTool({
          name: 'weather',
          arguments: { telemetry: { conversation_id: conversationId } },
        })
        assert.deepStrictEqual(second.content, TOOL_RESULT.content)
        assert.equal(findServerToolSpan(await getEvents(2)).session_id, conversationId)
      })
    })
  })
})
