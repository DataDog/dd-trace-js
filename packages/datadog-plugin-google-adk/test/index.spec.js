'use strict'

const assert = require('node:assert/strict')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')

createIntegrationTestSuite('google-adk', '@google/adk', { category: 'llm' }, (meta) => {
  const { agent } = meta

  beforeEach(async () => {
    await agent.load('google-adk')
  })

  afterEach(async () => {
    await agent.close()
  })

  function createRunner (model) {
    const rootAgent = new meta.mod.LlmAgent({
      name: 'test-agent',
      model,
      instruction: 'Answer briefly.',
    })
    return new meta.mod.InMemoryRunner({ agent: rootAgent, appName: 'test-app' })
  }

  async function run (runner, message = 'hello') {
    const session = await runner.sessionService.createSession({
      appName: 'test-app',
      userId: 'test-user',
    })
    const events = []
    for await (const event of runner.runAsync({
      userId: 'test-user',
      sessionId: session.id,
      newMessage: { parts: [{ text: message }] },
    })) {
      events.push(event)
    }
    return events
  }

  function createFakeModel (responses) {
    return new (class FakeLlm extends meta.mod.BaseLlm {
      constructor () {
        super({ model: 'fake-model' })
        this.responses = responses
      }

      async * generateContentAsync () {
        yield * this.responses.shift()
      }

      async connect () {
        throw new Error('Live mode is not supported by FakeLlm')
      }
    })()
  }

  it('traces a runner and model call', async () => {
    const model = createFakeModel([[{ content: { role: 'model', parts: [{ text: 'answer' }] } }]])
    const runner = createRunner(model)

    const traceAssertion = agent.assertSomeTraces((traces) => {
      const spans = traces.flat()
      const request = spans.find(span => span.resource === 'Runner.runAsync')
      assert.ok(request)
      assert.equal(request.name, 'google_adk.request')
      assert.equal(request.meta.component, 'google-adk')
      assert.equal(request.meta['google_adk.request.model'], 'fake-model')
      assert.equal(request.meta['google_adk.request.provider'], 'custom')
    })
    await run(runner)
    await traceAssertion
  })

  it('traces tool execution', async () => {
    const model = createFakeModel([
      [{ content: { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: { key: 'x' } } }] } }],
      [{ content: { role: 'model', parts: [{ text: 'done' }] } }],
    ])
    const tool = new meta.mod.FunctionTool({
      name: 'lookup',
      description: 'Looks up a value.',
      execute: () => ({ value: 1 }),
    })
    const rootAgent = new meta.mod.LlmAgent({
      name: 'test-agent',
      model,
      instruction: 'Use the lookup tool.',
      tools: [tool],
    })
    const runner = new meta.mod.InMemoryRunner({ agent: rootAgent, appName: 'test-app' })

    const traceAssertion = agent.assertSomeTraces((traces) => {
      const spans = traces.flat()
      const request = spans.find(span => span.resource === 'Runner.runAsync')
      const toolSpan = spans.find(span => span.resource === 'FunctionTool.runAsync')
      assert.ok(request)
      assert.ok(toolSpan)
      assert.equal(toolSpan.parent_id, request.span_id)
    })
    await run(runner)
    await traceAssertion
  })

  it('finishes the runner span when iteration stops early', async () => {
    const model = createFakeModel([[{ content: { role: 'model', parts: [{ text: 'answer' }] } }]])
    const runner = createRunner(model)
    const traceAssertion = agent.assertSomeTraces((traces) => {
      const request = traces.flat().find(span => span.resource === 'Runner.runAsync')
      assert.ok(request)
      assert.equal(request.duration > 0, true)
    })
    const session = await runner.sessionService.createSession({
      appName: 'test-app',
      userId: 'test-user',
    })
    const iterator = runner.runAsync({
      userId: 'test-user',
      sessionId: session.id,
      newMessage: { parts: [{ text: 'hello' }] },
    })
    await iterator.next()
    await iterator.return()
    await traceAssertion
  })
})
