'use strict'

const assert = require('node:assert/strict')
const { describe, beforeEach, it } = require('mocha')
const { withVersions } = require('../../../setup/mocha')

const {
  assertLlmObsSpanEvent,
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

    function agentMetadata (session, model = 'gemini-2.5-flash', tools = []) {
      return {
        agent_manifest: {
          framework: 'Google ADK',
          name: 'test-agent',
          model,
          description: 'Google ADK test agent',
          instructions: 'Answer briefly.',
          model_configuration: {},
          session_management: {
            session_id: session.id,
            user_id: 'test-user',
            app_name: 'test-app',
          },
          tools,
        },
      }
    }

    it('creates an agent span with a child GenAI span', async () => {
      const runner = createRunner()
      const { session } = await run(runner)

      const { apmSpans, llmobsSpans } = await getEvents(2)
      assert.equal(apmSpans.length, 2)
      assert.equal(llmobsSpans.length, 2)
      const agentSpan = apmSpans.find(span => span.resource === 'Runner.runAsync')
      const genaiSpan = apmSpans.find(span => span.name === 'google_genai.request')
      const agentEvent = llmobsSpans.find(event => event.meta['span.kind'] === 'agent')
      const genaiEvent = llmobsSpans.find(event => event.meta['span.kind'] === 'llm')

      assert.ok(agentSpan)
      assert.ok(genaiSpan)
      assert.ok(agentEvent)
      assert.ok(genaiEvent)
      assert.equal(genaiSpan.parent_id, agentSpan.span_id)
      assert.equal(agentSpan.meta['google_adk.request.model'], 'gemini-2.5-flash')
      assert.equal(agentSpan.meta['google_adk.request.provider'], 'google')
      assert.equal(genaiEvent.parent_id, agentEvent.span_id)
      assert.equal(genaiEvent.meta.model_name, 'gemini-2.5-flash')
      assert.equal(genaiEvent.meta.model_provider, 'google')
      assert.deepEqual(genaiEvent.meta.output.messages, [{ role: 'assistant', content: 'answer' }])
      assertLlmObsSpanEvent(agentEvent, {
        span: agentSpan,
        spanKind: 'agent',
        name: 'test-agent',
        inputValue: 'Hello, world!',
        outputValue: JSON.stringify([{ role: 'assistant', content: 'answer' }]),
        metadata: agentMetadata(session),
        sessionId: session.id,
        tags: { ml_app: 'test', integration: 'google_adk', user_id: 'test-user', app_name: 'test-app' },
      })
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
      const { session } = await run(runner, 'Use lookup with key x.')

      const { apmSpans, llmobsSpans } = await getEvents(4)
      assert.equal(apmSpans.length, 4)
      assert.equal(llmobsSpans.length, 4)
      assert.deepEqual(
        llmobsSpans.map(event => event.meta['span.kind']),
        ['agent', 'llm', 'tool', 'llm']
      )
      const agentEvent = llmobsSpans[0]
      const firstLlmEvent = llmobsSpans[1]
      const toolEvent = llmobsSpans[2]
      const secondLlmEvent = llmobsSpans[3]
      const agentSpan = apmSpans.find(span => span.resource === 'Runner.runAsync')
      const toolSpan = apmSpans.find(span => span.resource === 'FunctionTool.runAsync')
      assert.ok(agentSpan)
      assert.ok(toolSpan)
      assert.equal(agentSpan.meta['google_adk.request.model'], 'gemini-2.5-flash')
      assert.equal(agentSpan.meta['google_adk.request.provider'], 'google')
      assert.equal(firstLlmEvent.parent_id, agentEvent.span_id)
      assert.equal(secondLlmEvent.parent_id, agentEvent.span_id)
      assert.equal(toolEvent.parent_id, agentEvent.span_id)
      assertLlmObsSpanEvent(agentEvent, {
        span: agentSpan,
        spanKind: 'agent',
        name: 'test-agent',
        inputValue: 'Use lookup with key x.',
        outputValue: JSON.stringify([
          {
            role: 'assistant',
            toolCalls: [{
              name: 'lookup',
              arguments: { key: 'x' },
              toolId: 'call-1',
              type: 'function_call',
            }],
          },
          {
            role: 'user',
            toolResults: [{
              name: 'lookup',
              result: '{"value":1}',
              toolId: 'call-1',
              type: 'function_response',
            }],
          },
          { role: 'assistant', content: 'answer' },
        ]),
        metadata: agentMetadata(session, 'gemini-2.5-flash', [
          { name: 'lookup', description: 'Looks up a value.' },
        ]),
        sessionId: session.id,
        tags: { ml_app: 'test', integration: 'google_adk', user_id: 'test-user', app_name: 'test-app' },
      })
      assertLlmObsSpanEvent(toolEvent, {
        span: toolSpan,
        spanKind: 'tool',
        name: 'lookup',
        inputValue: '{"key":"x"}',
        outputValue: '{"value":1}',
        metadata: { description: 'Looks up a value.' },
        parentId: agentEvent.span_id,
        sessionId: session.id,
        tags: { ml_app: 'test', integration: 'google_adk' },
      })
    })

    it('marks a failed model call as an error', async () => {
      const runner = createRunner('gemini-does-not-exist')
      const { session } = await run(runner, 'This model should fail.')

      const { apmSpans, llmobsSpans } = await getEvents()
      const agentEvent = llmobsSpans.find(event => event.meta['span.kind'] === 'agent')
      const llmEvent = llmobsSpans.find(event => event.meta['span.kind'] === 'llm')
      const agentSpan = apmSpans.find(span => span.resource === 'Runner.runAsync')
      const llmSpan = apmSpans.find(span => span.name === 'google_genai.request')
      assert.ok(agentEvent)
      assert.ok(llmEvent)
      assert.ok(agentSpan)
      assert.ok(llmSpan)
      assert.equal(agentEvent.meta['error.message'], 'Model not found')
      assert.equal(agentEvent.meta['error.type'], 'Error')
      assert.equal(llmEvent.status, 'error')
      assertLlmObsSpanEvent(agentEvent, {
        span: agentSpan,
        spanKind: 'agent',
        name: 'test-agent',
        inputValue: 'This model should fail.',
        metadata: agentMetadata(session, 'gemini-does-not-exist'),
        error: {},
        sessionId: session.id,
        tags: { ml_app: 'test', integration: 'google_adk', user_id: 'test-user', app_name: 'test-app' },
      })
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

      const { apmSpans, llmobsSpans } = await getEvents()
      const agentEvents = llmobsSpans.filter(event => event.meta['span.kind'] === 'agent')
      assert.equal(agentEvents.length, 1)
      assert.ok(agentEvents[0])
      assert.ok(apmSpans.find(span => span.resource === 'Runner.runAsync'))
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

      const { apmSpans, llmobsSpans } = await getEvents()
      const toolEvent = llmobsSpans.find(event => event.name === 'Google ADK Code Execute')
      const toolSpan = apmSpans.find(span => span.resource === 'UnsafeLocalCodeExecutor.executeCode')
      assert.ok(toolEvent)
      assert.ok(toolSpan)
      assertLlmObsSpanEvent(toolEvent, {
        span: toolSpan,
        spanKind: 'tool',
        name: 'Google ADK Code Execute',
        inputValue: 'console.log("hi")',
        outputValue: 'hi\n',
        tags: { ml_app: 'test', integration: 'google_adk' },
      })
      assert.equal(toolSpan.meta['google_adk.request.model'], 'gemini-2.5-flash')
      assert.equal(toolSpan.meta['google_adk.request.provider'], 'google')
    })
  })
})
