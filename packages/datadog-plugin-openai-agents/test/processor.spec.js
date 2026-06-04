'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')

const { DDOpenAIAgentsProcessor } = require('../src/processor')
const log = require('../../dd-trace/src/log')

describe('DDOpenAIAgentsProcessor', () => {
  let warnStub

  beforeEach(() => {
    warnStub = sinon.stub(log, 'warn')
  })

  afterEach(() => {
    sinon.restore()
  })

  function makeIntegration (overrides = {}) {
    return {
      enabled: true,
      startTrace: sinon.stub(),
      endTrace: sinon.stub(),
      startSpan: sinon.stub(),
      endSpan: sinon.stub(),
      clearState: sinon.stub(),
      ...overrides,
    }
  }

  describe('when no integration is registered', () => {
    const processor = new DDOpenAIAgentsProcessor(() => undefined)

    it('returns a resolved promise from every lifecycle method without throwing', async () => {
      await processor.onTraceStart({})
      await processor.onTraceEnd({})
      await processor.onSpanStart({ spanData: { type: 'agent' } })
      await processor.onSpanEnd({ spanData: { type: 'agent' } })
      await processor.forceFlush()
      await processor.shutdown()
    })

    it('shutdown skips clearState when the integration is missing', async () => {
      await processor.shutdown()
      // No throw, nothing to assert beyond the absence of work.
    })
  })

  describe('when the integration is disabled', () => {
    const integration = makeIntegration({ enabled: false })
    const processor = new DDOpenAIAgentsProcessor(() => integration)

    it('skips startTrace/endTrace/startSpan/endSpan', async () => {
      await processor.onTraceStart({})
      await processor.onTraceEnd({})
      await processor.onSpanStart({ spanData: { type: 'agent' } })
      await processor.onSpanEnd({ spanData: { type: 'agent' } })
      sinon.assert.notCalled(integration.startTrace)
      sinon.assert.notCalled(integration.endTrace)
      sinon.assert.notCalled(integration.startSpan)
      sinon.assert.notCalled(integration.endSpan)
    })
  })

  describe('onSpanStart guards', () => {
    const integration = makeIntegration()
    const processor = new DDOpenAIAgentsProcessor(() => integration)

    it('returns without calling startSpan when spanData is absent (NoopSpan guard)', async () => {
      await processor.onSpanStart({})
      sinon.assert.notCalled(integration.startSpan)
    })

    it('returns without calling startSpan for span types that have no LLMObs kind', async () => {
      await processor.onSpanStart({ spanData: { type: 'generation' } })
      sinon.assert.notCalled(integration.startSpan)
    })

    it('maps recognised span types to the expected LLMObs kind', async () => {
      const cases = [
        ['agent', 'agent'],
        ['function', 'tool'],
        ['handoff', 'tool'],
        ['response', 'llm'],
        ['guardrail', 'task'],
        ['custom', 'task'],
      ]
      for (const [type, expectedKind] of cases) {
        integration.startSpan.resetHistory()
        await processor.onSpanStart({ spanData: { type } })
        sinon.assert.calledOnce(integration.startSpan)
        assert.strictEqual(integration.startSpan.firstCall.args[1], expectedKind)
      }
    })
  })

  describe('onSpanEnd guards', () => {
    const integration = makeIntegration()
    const processor = new DDOpenAIAgentsProcessor(() => integration)

    it('returns without calling endSpan when spanData is absent', async () => {
      await processor.onSpanEnd({})
      sinon.assert.notCalled(integration.endSpan)
    })
  })

  describe('error handling', () => {
    const err = new Error('boom')

    function processorWithThrowing (method) {
      const integration = makeIntegration()
      integration[method] = sinon.stub().throws(err)
      return [new DDOpenAIAgentsProcessor(() => integration), integration]
    }

    it('logs and swallows startTrace failures', async () => {
      const [p] = processorWithThrowing('startTrace')
      await p.onTraceStart({})
      sinon.assert.calledOnce(warnStub)
    })

    it('logs and swallows endTrace failures', async () => {
      const [p] = processorWithThrowing('endTrace')
      await p.onTraceEnd({})
      sinon.assert.calledOnce(warnStub)
    })

    it('logs and swallows startSpan failures', async () => {
      const [p] = processorWithThrowing('startSpan')
      await p.onSpanStart({ spanData: { type: 'agent' } })
      sinon.assert.calledOnce(warnStub)
    })

    it('logs and swallows endSpan failures', async () => {
      const [p] = processorWithThrowing('endSpan')
      await p.onSpanEnd({ spanData: { type: 'agent' } })
      sinon.assert.calledOnce(warnStub)
    })

    it('logs and swallows shutdown clearState failures', async () => {
      const [p] = processorWithThrowing('clearState')
      await p.shutdown()
      sinon.assert.calledOnce(warnStub)
    })
  })

  it('forceFlush resolves without doing work', async () => {
    const processor = new DDOpenAIAgentsProcessor(() => makeIntegration())
    await processor.forceFlush()
  })

  it('reads the integration lazily on each lifecycle event', async () => {
    let calls = 0
    const integrations = [makeIntegration(), makeIntegration()]
    const processor = new DDOpenAIAgentsProcessor(() => integrations[calls++ % 2])

    await processor.onTraceStart({})
    await processor.onTraceStart({})
    sinon.assert.calledOnce(integrations[0].startTrace)
    sinon.assert.calledOnce(integrations[1].startTrace)
  })
})
