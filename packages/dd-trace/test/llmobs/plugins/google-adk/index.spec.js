'use strict'

const assert = require('node:assert/strict')
const { describe, beforeEach, it } = require('mocha')
const { withVersions } = require('../../../setup/mocha')

const {
  assertLlmObsSpanEvent,
  MOCK_OBJECT,
  MOCK_STRING,
  useLlmObs,
} = require('../../util')

describe('Google ADK', () => {
  const { getEvents } = useLlmObs({
    // @ts-expect-error Multiple plugins are supported by the test agent.
    plugin: ['google-adk', 'google-genai'],
    traceTimeoutMs: 10000,
  })

  withVersions('google-adk', '@google/adk', version => {
    let adk
    let genai

    beforeEach(() => {
      const module = require(`../../../../../../versions/@google/adk@${version}`)
      adk = module.get()
      genai = module.get('@google/genai')
    })

    function createRunner (model = 'gemini-2.5-flash', tools = []) {
      const gemini = new adk.Gemini({ model, apiKey: '<not-a-real-key>' })
      gemini._apiClient = new genai.GoogleGenAI({
        apiKey: '<not-a-real-key>',
        httpOptions: { baseUrl: 'http://127.0.0.1:9126/vcr/genai' },
      })
      const agent = new adk.LlmAgent({
        name: 'test-agent',
        model: gemini,
        description: 'Google ADK test agent',
        instruction: 'Answer briefly.',
        tools,
      })
      return new adk.InMemoryRunner({ agent, appName: 'test-app' })
    }

    async function run (runner, prompt = 'Hello, world!') {
      const session = await runner.sessionService.createSession({
        appName: 'test-app',
        userId: 'test-user',
      })
      const events = []
      for await (const event of runner.runAsync({
        userId: 'test-user',
        sessionId: session.id,
        newMessage: { parts: [{ text: prompt }] },
      })) {
        events.push(event)
      }
      return { events, session }
    }

    it('creates an agent span with a child GenAI span', async () => {
      const runner = createRunner()
      await run(runner)

      const { apmSpans, llmobsSpans } = await getEvents(2)
      const agentSpan = apmSpans.find(span => span.resource === 'Runner.runAsync')
      const genaiSpan = apmSpans.find(span => span.name === 'google_genai.request')
      const agentEvent = llmobsSpans.find(event => event.meta['span.kind'] === 'agent')

      assert.ok(agentSpan)
      assert.ok(genaiSpan)
      assert.equal(genaiSpan.parent_id, agentSpan.span_id)
      assertLlmObsSpanEvent(agentEvent, {
        span: agentSpan,
        spanKind: 'agent',
        name: 'test-agent',
        inputValue: 'Hello, world!',
        outputValue: MOCK_STRING,
        metadata: MOCK_OBJECT,
        sessionId: agentEvent.session_id,
        tags: { ml_app: 'test', integration: 'google_adk', user_id: 'test-user', app_name: 'test-app' },
      })
      assert.equal(llmobsSpans.filter(event => event.meta['span.kind'] === 'llm').length, 1)
    })

    it('creates a tool span for a FunctionTool', async () => {
      const tool = new adk.FunctionTool({
        name: 'lookup',
        description: 'Looks up a value.',
        parameters: {
          type: 'object',
          properties: { key: { type: 'string' } },
        },
        execute: () => ({ value: 1 }),
      })
      const runner = createRunner('gemini-2.5-flash', [tool])
      await run(runner, 'Use lookup with key x.')

      const { apmSpans, llmobsSpans } = await getEvents()
      const toolEvent = llmobsSpans.find(event => event.meta['span.kind'] === 'tool')
      const toolSpan = apmSpans.find(span => span.resource === 'FunctionTool.runAsync')
      assert.ok(toolEvent)
      assert.ok(toolSpan)
      assertLlmObsSpanEvent(toolEvent, {
        span: toolSpan,
        spanKind: 'tool',
        name: 'lookup',
        inputValue: '{"key":"x"}',
        outputValue: '{"value":1}',
        metadata: { description: 'Looks up a value.' },
        parentId: toolSpan.parent_id,
        sessionId: toolEvent.session_id,
        tags: { ml_app: 'test', integration: 'google_adk' },
      })
    })

    it('marks a failed model call as an error', async () => {
      const runner = createRunner('gemini-does-not-exist')
      await run(runner, 'This model should fail.')

      const { llmobsSpans } = await getEvents()
      const agentEvent = llmobsSpans.find(event => event.meta['span.kind'] === 'agent')
      assert.ok(agentEvent)
      assert.equal(agentEvent.status, 'error')
    })

    it('finishes the agent span on an early break', async () => {
      const runner = createRunner()
      const session = await runner.sessionService.createSession({
        appName: 'test-app',
        userId: 'test-user',
      })
      const iterator = runner.runAsync({
        userId: 'test-user',
        sessionId: session.id,
        newMessage: { parts: [{ text: 'Stop after the first event.' }] },
      })
      const result = await iterator.next()
      assert.ok(result.value)
      await iterator.return()

      const { llmobsSpans } = await getEvents()
      assert.ok(llmobsSpans.some(event => event.meta['span.kind'] === 'agent'))
    })

    it('captures local code execution as a tool span', async () => {
      const executor = new adk.UnsafeLocalCodeExecutor()
      await executor.executeCode({
        invocationContext: { agent: { model: 'gemini-2.5-flash' } },
        codeExecutionInput: {
          code: 'console.log("hi")',
          language: adk.CodeExecutionLanguage.JAVASCRIPT,
          inputFiles: [],
          executionId: 'x',
        },
      })

      const { llmobsSpans } = await getEvents()
      const toolEvent = llmobsSpans.find(event => event.name === 'Google ADK Code Execute')
      assert.ok(toolEvent)
      assert.equal(toolEvent.meta.input.value, 'console.log("hi")')
      assert.match(toolEvent.meta.output.value, /hi/)
    })
  })
})
