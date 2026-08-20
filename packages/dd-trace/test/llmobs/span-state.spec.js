'use strict'

const assert = require('node:assert/strict')

const { after, before, describe, it } = require('mocha')
const eventWriter = require('../../src/opentracing/event-writer')
const spanState = require('../../src/llmobs/span-state')

function makeSpan (parent, tags) {
  const context = {}
  eventWriter.initializeContext(context, {
    parentId: parent ? 'parent-id' : undefined,
    spanId: parent ? 'child-id' : 'parent-id',
    trace: parent?.context()._trace,
  })
  context.toSpanId = () => parent ? 'child' : 'parent'
  const span = {
    context () { return context },
  }
  eventWriter.startSpan(span, {
    context,
    processor: {},
    prioritySampler: {},
    debug: false,
    integrationName: 'llmobs',
    links: [],
    startTime: 10,
    parentContext: parent?.context(),
    operationName: parent ? 'child-operation' : 'parent-operation',
  })
  if (tags) eventWriter.setTags(span, tags)
  return span
}

describe('LLMObs span state projection', () => {
  before(() => spanState.enable())
  after(() => spanState.disable())

  it('retains the start operation name', () => {
    const span = makeSpan()
    assert.strictEqual(spanState.getOperationName(span), 'parent-operation')

    eventWriter.setOperationName(span, 'updated-operation')

    assert.strictEqual(spanState.getOperationName(span), 'parent-operation')
  })

  it('tracks error tag deletion and clearing', () => {
    const span = makeSpan()
    eventWriter.setTag(span, 'error', true)
    eventWriter.setTag(span, 'error.type', 'Error')
    assert.strictEqual(spanState.hasError(span), true)

    eventWriter.deleteTag(span, 'error')
    assert.strictEqual(spanState.hasError(span), true)

    eventWriter.clearTags(span)
    assert.strictEqual(spanState.hasError(span), false)
  })

  it('captures initial tags written immediately after the start event', () => {
    const span = makeSpan(undefined, { error: true })

    assert.strictEqual(spanState.hasError(span), true)
  })

  it('tracks gen_ai ancestry as tags are written and removed', () => {
    const parent = makeSpan()
    const child = makeSpan(parent)
    eventWriter.setTag(parent, 'gen_ai.operation.name', 'invoke_agent')
    assert.strictEqual(spanState.findGenAIAncestorSpanId(child), 'parent')

    eventWriter.deleteTag(parent, 'gen_ai.operation.name')
    assert.strictEqual(spanState.findGenAIAncestorSpanId(child), null)
  })

  it('shares propagated trace tag overwrites across contexts', () => {
    const parent = makeSpan()
    const child = makeSpan(parent)
    eventWriter.setTraceTag(parent, '_dd.p.llmobs_sid', 'one')
    assert.strictEqual(spanState.getTraceTags(child)['_dd.p.llmobs_sid'], 'one')

    eventWriter.setTraceTag(child, '_dd.p.llmobs_sid', 'two')
    assert.strictEqual(spanState.getTraceTags(parent)['_dd.p.llmobs_sid'], 'two')
  })

  it('replays propagation tags from a pre-populated trace', () => {
    const context = {}
    const trace = {
      started: [],
      finished: [],
      tags: { '_dd.p.llmobs_ml_app': 'upstream-app' },
    }

    eventWriter.initializeContext(context, { trace })

    assert.strictEqual(spanState.getTraceTags(context)['_dd.p.llmobs_ml_app'], 'upstream-app')
  })
})
