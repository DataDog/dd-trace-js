'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it, before, after } = require('mocha')
const sinon = require('sinon')

const { useEnv } = require('../../../../../../integration-tests/helpers')
const { withVersions } = require('../../../setup/mocha')
const { useLlmObs } = require('../../util')

const TOOL_RESULT = { content: [{ type: 'text', text: 'sunny' }] }
const ECHOED_ID = '0123456789abcdef0123456789abcdef'
const INTENT = 'Check the weather to plan a trip'
const CONVERSATION_ID_PATTERN = /conversation_id for this server is "([0-9a-f]{32})"/

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

/**
 * @param {{ tags: string[] }} span
 */
function getSessionSource (span) {
  return span.tags.find(tag => tag.startsWith('mcp_session_source:'))?.slice('mcp_session_source:'.length)
}

/**
 * @param {string} version
 */
function loadSdk1 (version) {
  const versionModule = require(`../../../../../../versions/@modelcontextprotocol/sdk@${version}`)
  const { Client } = versionModule.get('@modelcontextprotocol/sdk/client')
  const clientEntryPath = versionModule.getPath('@modelcontextprotocol/sdk/client')
  const sdkDir = path.resolve(path.dirname(clientEntryPath), '..', '..', '..')
  const { McpServer } = require(path.join(sdkDir, 'dist/cjs/server/mcp.js'))
  const { InMemoryTransport } = versionModule.get('@modelcontextprotocol/sdk/inMemory.js')

  /**
   * @param {string} [transportSessionId]
   */
  return async function connect (transportSessionId) {
    const server = new McpServer({ name: 'test-server', version: '1.0.0' })
    server.registerTool('weather', { description: 'Weather', inputSchema: {} }, async () => TOOL_RESULT)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    if (transportSessionId) serverTransport.sessionId = transportSessionId
    await server.connect(serverTransport)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(clientTransport)
    return { client, server }
  }
}

describe('integrations', () => {
  describe('modelcontextprotocol-sdk session capture', () => {
    useEnv({ DD_MCP_CAPTURE_INTENT: 'false' })
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
        server.registerTool('broken', { description: 'Fails without a message', inputSchema: {} }, async () => ({
          isError: true,
          content: [],
        }))
        server.registerTool('track', {
          description: 'Has its own telemetry argument',
          inputSchema: serverModule.fromJsonSchema({ type: 'object', properties: { telemetry: { type: 'object' } } }),
        }, async args => {
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

        it('removes an empty telemetry argument and generates a session ID', async () => {
          const result = await client.callTool({ name: 'weather', arguments: { city: 'Lima', telemetry: {} } })

          assert.equal(result.isError, undefined)
          assert.deepStrictEqual(receivedArguments, { city: 'Lima' })
          assert.equal(findServerToolSpan(await getEvents(2)).session_id, getInstructedConversationId(result))
        })

        it('uses the echoed conversation ID and removes the telemetry argument', async () => {
          const result = await client.callTool({
            name: 'weather',
            arguments: { city: 'Rome', telemetry: { conversation_id: ECHOED_ID } },
          })

          assert.deepStrictEqual(result.content, TOOL_RESULT.content)
          assert.deepStrictEqual(receivedArguments, { city: 'Rome' })

          const span = findServerToolSpan(await getEvents(2))
          assert.equal(span.session_id, ECHOED_ID)
          assert.ok(span.tags.includes('mcp_session_source:echoed'))
          assert.deepStrictEqual(JSON.parse(span.meta.input.value).params.arguments, { city: 'Rome' })
        })

        it('generates a session ID for an echoed value it did not generate', async () => {
          const result = await client.callTool({
            name: 'weather',
            arguments: { city: 'Rome', telemetry: { conversation_id: 'made-up' } },
          })

          const span = findServerToolSpan(await getEvents(2))
          assert.equal(span.session_id, getInstructedConversationId(result))
          assert.notEqual(getSessionSource(span), 'echoed')
        })

        it('removes a null telemetry argument', async () => {
          const result = await client.callTool({ name: 'weather', arguments: { city: 'Rome', telemetry: null } })

          assert.equal(result.isError, undefined)
          assert.deepStrictEqual(receivedArguments, { city: 'Rome' })
          await getEvents(2)
        })

        it('leaves a call with the tool\'s own telemetry argument unchanged', async () => {
          const result = await client.callTool({ name: 'track', arguments: { telemetry: { event: 'click' } } })

          assert.deepStrictEqual(result.content, TOOL_RESULT.content)
          assert.deepStrictEqual(receivedArguments, { telemetry: { event: 'click' } })
          const span = (await getEvents(2)).llmobsSpans.find(span => span.name === 'track')
          assert.equal(span.session_id, undefined)
          assert.equal(getSessionSource(span), undefined)
        })

        it('keeps the session of a parent span', async () => {
          const tracer = require('../../../../../..')
          const options = { kind: 'workflow', name: 'agent', sessionId: 'parent-session' }
          const result = await tracer.llmobs.trace(options, () =>
            client.callTool({ name: 'weather', arguments: { city: 'Oslo' } }))

          assert.deepStrictEqual(result.content, TOOL_RESULT.content)
          const span = findServerToolSpan(await getEvents(3))
          assert.equal(span.session_id, 'parent-session')
          assert.equal(getSessionSource(span), undefined)
        })

        it('does not add the instruction to an error result without text', async () => {
          const result = await client.callTool({ name: 'broken', arguments: {} })

          assert.deepStrictEqual(result.content, [])
          const span = (await getEvents(2)).llmobsSpans.find(span => span.name === 'broken')
          assert.match(span.session_id, /^[0-9a-f]{32}$/)
        })
      })

      describe('first calls on one connection', () => {
        let client
        let server

        before(async () => {
          ({ client, server } = await connect())
        })

        after(async () => {
          await client?.close()
          await server?.close()
        })

        it('reuses one new ID for parallel first calls', async () => {
          const results = await Promise.all([
            client.callTool({ name: 'weather', arguments: { city: 'Paris' } }),
            client.callTool({ name: 'weather', arguments: { city: 'Rome' } }),
          ])

          const [first, second] = results.map(getInstructedConversationId)
          assert.ok(first)
          assert.equal(second, first)

          const { llmobsSpans } = await getEvents(4)
          const serverSpans = llmobsSpans.filter(span => span.name === 'weather')
          assert.deepStrictEqual(serverSpans.map(span => span.session_id), [first, first])
          assert.deepStrictEqual(serverSpans.map(getSessionSource).sort(), ['generated', 'reused'])
        })
      })

      describe('a pending ID on one connection', () => {
        let client
        let server
        let clock

        before(async () => {
          clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['performance'] })
          ;({ client, server } = await connect())
        })

        after(async () => {
          clock.restore()
          await client?.close()
          await server?.close()
        })

        it('expires 2 seconds after it was generated, even when it was reused', async () => {
          const first = await client.callTool({ name: 'weather', arguments: { city: 'Oslo' } })
          await getEvents(2)
          clock.tick(1999)
          const second = await client.callTool({ name: 'weather', arguments: { city: 'Oslo' } })
          assert.equal(getSessionSource(findServerToolSpan(await getEvents(2))), 'reused')
          clock.tick(1)
          const third = await client.callTool({ name: 'weather', arguments: { city: 'Oslo' } })
          await getEvents(2)

          assert.equal(getInstructedConversationId(second), getInstructedConversationId(first))
          assert.notEqual(getInstructedConversationId(third), getInstructedConversationId(second))
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
      let connectSdk1

      before(async () => {
        connectSdk1 = loadSdk1(version)
        ;({ client, server } = await connectSdk1())
      })

      after(async () => {
        await client?.close()
        await server?.close()
      })

      it('keeps the result and does not set a session ID with a transport session', async () => {
        const session = await connectSdk1('transport-session')
        try {
          const result = await session.client.callTool({ name: 'weather', arguments: {} })

          assert.deepStrictEqual(result.content, TOOL_RESULT.content)
          assert.equal(findServerToolSpan(await getEvents(2)).session_id, undefined)
        } finally {
          await session.client.close()
          await session.server.close()
        }
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

  describe('modelcontextprotocol-sdk with the default configuration', () => {
    const { getEvents } = useLlmObs({ plugin: 'modelcontextprotocol-sdk' })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/server', '>=2', version => {
      let client
      let server
      let receivedArguments

      before(async () => {
        const serverModule = require(`../../../../../../versions/@modelcontextprotocol/server@${version}`).get()
        const clientModule = require('../../../../../../versions/@modelcontextprotocol/client@2').get()

        server = new serverModule.McpServer({ name: 'test-server', version: '1.0.0' })
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
        await server.connect(serverTransport)
        client = new clientModule.Client({ name: 'test-client', version: '1.0.0' })
        await client.connect(clientTransport)
      })

      after(async () => {
        await client?.close()
        await server?.close()
      })

      it('asks for the intent and the conversation ID in tools/list', async () => {
        const { inputSchema } = (await client.listTools()).tools[0]

        assert.deepStrictEqual(Object.keys(inputSchema.properties.telemetry.properties), ['intent', 'conversation_id'])
        assert.deepStrictEqual(inputSchema.properties.telemetry.required, ['intent'])
        assert.deepStrictEqual(inputSchema.required, ['city', 'telemetry'])
        await getEvents(2)
      })

      it('records the intent and the echoed session, and calls the tool without the telemetry argument', async () => {
        const result = await client.callTool({
          name: 'weather',
          arguments: { city: 'Paris', telemetry: { intent: INTENT, conversation_id: ECHOED_ID } },
        })

        assert.deepStrictEqual(result.content, TOOL_RESULT.content)
        assert.deepStrictEqual(receivedArguments, { city: 'Paris' })
        const span = findServerToolSpan(await getEvents(2))
        assert.equal(span.meta.intent, INTENT)
        assert.equal(span.session_id, ECHOED_ID)
        assert.equal(getSessionSource(span), 'echoed')
      })
    })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/sdk', version => {
      let client
      let server

      before(async () => {
        const connectSdk1 = loadSdk1(version)
        ;({ client, server } = await connectSdk1())
      })

      after(async () => {
        await client?.close()
        await server?.close()
      })

      it('records the intent and the echoed session, and removes the telemetry argument', async () => {
        const telemetry = { intent: INTENT, conversation_id: ECHOED_ID }
        await client.callTool({ name: 'weather', arguments: { telemetry } })

        const span = findServerToolSpan(await getEvents(2))
        assert.equal(span.meta.intent, INTENT)
        assert.equal(span.session_id, ECHOED_ID)
        assert.deepStrictEqual(JSON.parse(span.meta.input.value).params.arguments, {})
      })
    })
  })

  describe('modelcontextprotocol-sdk with MCP enrichment disabled', () => {
    useEnv({ DD_MCP_ENRICHMENT_ENABLED: 'false' })
    const { getEvents } = useLlmObs({ plugin: 'modelcontextprotocol-sdk' })

    withVersions('modelcontextprotocol-sdk', '@modelcontextprotocol/server', '>=2', version => {
      let client
      let server
      let receivedArguments

      before(async () => {
        const serverModule = require(`../../../../../../versions/@modelcontextprotocol/server@${version}`).get()
        const clientModule = require('../../../../../../versions/@modelcontextprotocol/client@2').get()

        server = new serverModule.McpServer({ name: 'test-server', version: '1.0.0' })
        server.registerTool('weather', {
          description: 'Weather for a city',
          inputSchema: serverModule.fromJsonSchema({
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
            additionalProperties: false,
          }),
        }, async args => {
          receivedArguments = args
          return TOOL_RESULT
        })
        server.registerTool('track', {
          description: 'Has its own telemetry argument',
          inputSchema: serverModule.fromJsonSchema({ type: 'object', properties: { telemetry: { type: 'object' } } }),
        }, async args => {
          receivedArguments = args
          return TOOL_RESULT
        })

        const [clientTransport, serverTransport] = serverModule.InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        client = new clientModule.Client({ name: 'test-client', version: '1.0.0' })
        await client.connect(clientTransport)
      })

      after(async () => {
        await client?.close()
        await server?.close()
      })

      it('keeps tool schemas unchanged', async () => {
        const result = await client.listTools()

        assert.equal(result.tools.find(tool => tool.name === 'weather').inputSchema.properties.telemetry, undefined)
        await getEvents(2)
      })

      it('removes a telemetry argument that a client kept from an earlier tools/list', async () => {
        const result = await client.callTool({
          name: 'weather',
          arguments: { city: 'Paris', telemetry: { intent: INTENT, conversation_id: ECHOED_ID } },
        })

        assert.equal(result.isError, undefined)
        assert.deepStrictEqual(receivedArguments, { city: 'Paris' })
        const span = findServerToolSpan(await getEvents(2))
        assert.equal(span.session_id, undefined)
        assert.equal(span.meta.intent, undefined)
      })

      for (const telemetry of [{}, { event: 'click' }]) {
        it(`passes the tool its own telemetry argument ${JSON.stringify(telemetry)}`, async () => {
          await client.callTool({ name: 'track', arguments: { telemetry } })

          assert.deepStrictEqual(receivedArguments, { telemetry })
          await getEvents(2)
        })
      }
    })
  })
})
