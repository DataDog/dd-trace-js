'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')

const { OpenAIAgentsIntegration } = require('../src/integration')

function makeFakeSpan () {
  return {
    setTag: sinon.stub(),
    finish: sinon.stub(),
    context: () => ({ toSpanId: () => 'dd-span-id' }),
  }
}

function makeFakeTracer (preseededSpans = []) {
  const startSpan = sinon.stub()
  preseededSpans.forEach((span, i) => startSpan.onCall(i).returns(span))
  startSpan.callsFake(() => makeFakeSpan())
  return { startSpan }
}

function build ({ tracerSpans = [] } = {}) {
  const tracer = makeFakeTracer(tracerSpans)
  const integration = new OpenAIAgentsIntegration({
    tracer,
    config: { llmobs: { enabled: false } },
  })
  return { integration, tracer }
}

afterEach(() => sinon.restore())

describe('OpenAIAgentsIntegration (APM-only paths)', () => {
  describe('enabled flag', () => {
    it('starts disabled and flips via setEnabled', () => {
      const { integration } = build()
      assert.strictEqual(integration.enabled, false)
      integration.setEnabled(true)
      assert.strictEqual(integration.enabled, true)
      integration.setEnabled(false)
      assert.strictEqual(integration.enabled, false)
    })
  })

  describe('setClientBaseURL', () => {
    it('ignores non-string baseURL values', () => {
      const { integration, tracer } = build()
      integration.setClientBaseURL(undefined)
      integration.setClientBaseURL(null)
      integration.setClientBaseURL(123)
      sinon.assert.notCalled(tracer.startSpan)
    })

    it('ignores the empty string', () => {
      const { integration } = build()
      integration.setClientBaseURL('')
    })

    it('accepts a recognised URL', () => {
      const { integration } = build()
      integration.setClientBaseURL('https://my-resource.openai.azure.com/openai')
    })
  })

  describe('startTrace', () => {
    it('does nothing when traceId is missing', () => {
      const { integration, tracer } = build()
      integration.startTrace({})
      sinon.assert.notCalled(tracer.startSpan)
    })

    it('falls back to the default workflow name when oaiTrace.name is empty', () => {
      const { integration, tracer } = build()
      integration.startTrace({ traceId: 't1' })
      sinon.assert.calledOnce(tracer.startSpan)
      assert.strictEqual(tracer.startSpan.firstCall.args[0], 'Agent workflow')
    })

    it('uses oaiTrace.name when provided', () => {
      const { integration, tracer } = build()
      integration.startTrace({ traceId: 't1', name: 'My workflow', groupId: 'g1' })
      assert.strictEqual(tracer.startSpan.firstCall.args[0], 'My workflow')
    })
  })

  describe('endTrace / #completeWorkflowSpan', () => {
    it('does nothing when traceId is missing', () => {
      const { integration } = build()
      integration.endTrace({})
    })

    it('does nothing when no span is mapped to the traceId', () => {
      const { integration } = build()
      integration.endTrace({ traceId: 'unknown' })
    })

    it('applies a rootAgentSpan error with a message onto the workflow span', () => {
      const workflowSpan = makeFakeSpan()
      const { integration } = build({ tracerSpans: [workflowSpan, makeFakeSpan()] })
      integration.startTrace({ traceId: 't1' })
      integration.startSpan(
        { spanId: 's1', traceId: 't1', parentId: null, spanData: { type: 'agent' } },
        'agent'
      )
      integration.endSpan({
        spanId: 's1',
        traceId: 't1',
        parentId: null,
        spanData: { type: 'agent' },
        error: { message: 'oh no' },
      })
      sinon.assert.calledWith(workflowSpan.setTag, 'error', true)
      sinon.assert.calledWith(workflowSpan.setTag, 'error.type', sinon.match.string)
      sinon.assert.calledWith(workflowSpan.setTag, 'error.message', 'oh no')
      sinon.assert.called(workflowSpan.finish)
    })

    it('still flags an error when rootAgentSpan.error has no message', () => {
      const workflowSpan = makeFakeSpan()
      const { integration } = build({ tracerSpans: [workflowSpan, makeFakeSpan()] })
      integration.startTrace({ traceId: 't1' })
      integration.startSpan(
        { spanId: 's1', traceId: 't1', parentId: null, spanData: { type: 'agent' } },
        'agent'
      )
      integration.endSpan({
        spanId: 's1',
        traceId: 't1',
        parentId: null,
        spanData: { type: 'agent' },
        error: {},
      })
      sinon.assert.calledWith(workflowSpan.setTag, 'error', true)
      const messageCalls = workflowSpan.setTag.getCalls().filter(c => c.args[0] === 'error.message')
      assert.strictEqual(messageCalls.length, 0)
    })
  })

  describe('startSpan', () => {
    it('does nothing when spanId is missing', () => {
      const { integration, tracer } = build()
      integration.startSpan({}, 'agent')
      sinon.assert.notCalled(tracer.startSpan)
    })

    it('defaults span.kind to internal for unknown LLMObs kinds', () => {
      const { integration, tracer } = build()
      integration.startSpan(
        { spanId: 's1', traceId: 't1', spanData: { type: 'custom' } },
        'unknown-kind'
      )
      const tags = tracer.startSpan.firstCall.args[1].tags
      assert.strictEqual(tags['span.kind'], 'internal')
    })

    it('maps llm kind to span.kind=client', () => {
      const { integration, tracer } = build()
      integration.startSpan(
        { spanId: 's1', traceId: 't1', spanData: { type: 'response' } },
        'llm'
      )
      const tags = tracer.startSpan.firstCall.args[1].tags
      assert.strictEqual(tags['span.kind'], 'client')
    })

    it('maps agent kind to span.kind=internal', () => {
      const { integration, tracer } = build()
      integration.startSpan(
        { spanId: 's1', traceId: 't1', spanData: { type: 'agent' } },
        'agent'
      )
      const tags = tracer.startSpan.firstCall.args[1].tags
      assert.strictEqual(tags['span.kind'], 'internal')
    })
  })

  describe('endSpan', () => {
    it('does nothing when spanId is unknown', () => {
      const { integration } = build()
      integration.endSpan({ spanId: 'missing', spanData: { type: 'function' } })
    })

    it('finishes the dd-trace span on end', () => {
      const ddSpan = makeFakeSpan()
      const { integration } = build({ tracerSpans: [ddSpan] })
      integration.startSpan(
        { spanId: 's1', traceId: 't1', spanData: { type: 'function' } },
        'tool'
      )
      integration.endSpan({ spanId: 's1', spanData: { type: 'function' } })
      sinon.assert.called(ddSpan.finish)
    })
  })

  describe('#resolveParent', () => {
    it('uses the parent dd-trace span when parentId is mapped', () => {
      const parentSpan = makeFakeSpan()
      const childSpan = makeFakeSpan()
      const { integration, tracer } = build({ tracerSpans: [parentSpan, childSpan] })
      integration.startSpan(
        { spanId: 'p1', traceId: 't1', spanData: { type: 'agent' } },
        'agent'
      )
      integration.startSpan(
        { spanId: 'c1', traceId: 't1', parentId: 'p1', spanData: { type: 'function' } },
        'tool'
      )
      assert.strictEqual(tracer.startSpan.secondCall.args[1].childOf, parentSpan)
    })

    it('falls back to the trace root span when parentId has no mapping', () => {
      const root = makeFakeSpan()
      const child = makeFakeSpan()
      const { integration, tracer } = build({ tracerSpans: [root, child] })
      integration.startTrace({ traceId: 't1' })
      integration.startSpan(
        { spanId: 's1', traceId: 't1', parentId: 'unknown-parent', spanData: { type: 'agent' } },
        'agent'
      )
      assert.strictEqual(tracer.startSpan.secondCall.args[1].childOf, root)
    })

    it('returns undefined when neither parent nor trace root is mapped', () => {
      const orphan = makeFakeSpan()
      const { integration, tracer } = build({ tracerSpans: [orphan] })
      integration.startSpan(
        { spanId: 's1', traceId: 'no-trace', parentId: 'no-parent', spanData: { type: 'agent' } },
        'agent'
      )
      assert.strictEqual(tracer.startSpan.firstCall.args[1].childOf, undefined)
    })
  })

  describe('clearState', () => {
    it('finishes every in-flight dd-trace span and clears bookkeeping', () => {
      const workflow = makeFakeSpan()
      const agentSpan = makeFakeSpan()
      const { integration } = build({ tracerSpans: [workflow, agentSpan] })
      integration.startTrace({ traceId: 't1' })
      integration.startSpan(
        { spanId: 's1', traceId: 't1', spanData: { type: 'agent' } },
        'agent'
      )
      integration.clearState()
      sinon.assert.called(workflow.finish)
      sinon.assert.called(agentSpan.finish)
      // After clearState, a second endTrace should be a no-op because the
      // span map was cleared.
      integration.endTrace({ traceId: 't1' })
    })
  })
})
