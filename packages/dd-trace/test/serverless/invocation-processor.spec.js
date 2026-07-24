'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

require('../setup/core')

const { storage } = require('../../../datadog-core')
const {
  ServerlessInvocationProcessor,
  channels,
} = require('../../src/serverless/index')

const legacyStorage = storage('legacy')

describe('serverless ServerlessInvocationProcessor', () => {
  let tracer
  let flushCoordinator
  let processor
  let spans

  beforeEach(() => {
    spans = []
    tracer = {
      startSpan: sinon.stub().callsFake((name, options) => {
        const span = createSpan(name, options)
        spans.push(span)
        return span
      }),
      extract: sinon.stub(),
    }
    flushCoordinator = {
      flush: sinon.stub().callsFake((_options, done) => {
        if (done) done({ outcome: 'drained' })
      }),
    }
    processor = new ServerlessInvocationProcessor(tracer, { flushCoordinator })
    processor.enable()
  })

  afterEach(() => {
    processor.disable()
    legacyStorage.enterWith(undefined)
    sinon.restore()
  })

  it('starts a serverless root span and activates it for user code', () => {
    const token = {}
    const parentContext = { traceId: 'parent' }
    tracer.extract.returns(parentContext)

    const event = startEvent(token, {
      carrier: { 'x-datadog-trace-id': '1' },
      functionName: 'handler',
      handlerName: 'api/users',
      operationName: 'vercel.invoke',
      route: '/users',
      tags: {
        'vercel.region': 'iad1',
      },
    })

    let activeSpan
    channels.invocationStart.runStores(event, () => {
      activeSpan = legacyStorage.getStore().span
    })

    const span = spans[0]
    assert.strictEqual(activeSpan, span)
    assert.strictEqual(event.context.span, span)
    sinon.assert.calledWith(tracer.extract, 'text_map', { 'x-datadog-trace-id': '1' })
    sinon.assert.calledWith(tracer.startSpan, 'vercel.invoke', sinon.match({
      childOf: parentContext,
      tags: sinon.match({
        component: 'vercel',
        'span.kind': 'server',
        'span.type': 'serverless',
        'resource.name': 'api/users',
        'serverless.platform': 'vercel',
        'serverless.function.name': 'handler',
        'serverless.handler': 'api/users',
        'http.route': '/users',
        'vercel.region': 'iad1',
      }),
      integrationName: 'vercel',
    }))
  })

  it('finishes the root span and flushes before invoking the done callback', () => {
    const token = {}
    const done = sinon.spy()
    const event = startEvent(token, { deadlineMs: 1234 })

    channels.invocationStart.runStores(event, () => {})
    channels.invocationFinish.publish({
      kind: 'serverless',
      operation: 'invocation',
      token,
      source: event.source,
      context: { done },
      data: { finishTime: 42 },
    })

    assert.strictEqual(spans[0].finished, true)
    assert.strictEqual(spans[0].finishTime, 42)
    sinon.assert.calledWith(flushCoordinator.flush, sinon.match({
      reason: 'finish',
      token,
      deadlineMs: 1234,
      source: event.source,
    }), sinon.match.func)
    sinon.assert.calledOnce(done)
  })

  it('tags errors before finishing and flushing the root span', () => {
    const token = {}
    const error = new Error('boom')

    channels.invocationStart.runStores(startEvent(token), () => {})
    channels.invocationError.publish({
      kind: 'serverless',
      operation: 'invocation',
      token,
      error,
    })

    assert.strictEqual(spans[0].tags['error.type'], 'Error')
    assert.strictEqual(spans[0].tags['error.message'], 'boom')
    assert.strictEqual(spans[0].finished, true)
    sinon.assert.calledWith(flushCoordinator.flush, sinon.match({ reason: 'error' }), undefined)
  })

  it('finishes the selected invocation on timeout', () => {
    const token = {}
    const deadlineMs = Date.now() + 5

    channels.invocationStart.runStores(startEvent(token, { deadlineMs }), () => {})
    channels.invocationTimeout.publish({
      kind: 'serverless',
      operation: 'invocation',
      token,
    })

    assert.strictEqual(spans[0].tags['error.type'], 'Error')
    assert.strictEqual(spans[0].tags['error.message'], 'Serverless invocation timed out')
    assert.strictEqual(spans[0].finished, true)
    sinon.assert.calledWith(flushCoordinator.flush, sinon.match({
      reason: 'timeout',
      deadlineMs,
    }), undefined)
  })

  it('ignores duplicate completion events for the same token', () => {
    const token = {}

    channels.invocationStart.runStores(startEvent(token), () => {})
    channels.invocationFinish.publish({
      kind: 'serverless',
      operation: 'invocation',
      token,
    })
    channels.invocationError.publish({
      kind: 'serverless',
      operation: 'invocation',
      token,
      error: new Error('late error'),
    })

    assert.strictEqual(spans[0].finishCount, 1)
    sinon.assert.calledOnce(flushCoordinator.flush)
  })

  it('does not start an invocation without an opaque object token', () => {
    channels.invocationStart.runStores(startEvent(undefined), () => {})
    channels.invocationStart.runStores(startEvent('request-id'), () => {})

    sinon.assert.notCalled(tracer.startSpan)
  })

  it('reuses the active invocation when a token is started twice', () => {
    const token = {}
    const first = startEvent(token)
    const duplicate = startEvent(token)
    let firstStore
    let duplicateStore

    channels.invocationStart.runStores(first, () => {
      firstStore = legacyStorage.getStore()
    })
    channels.invocationStart.runStores(duplicate, () => {
      duplicateStore = legacyStorage.getStore()
    })

    sinon.assert.calledOnce(tracer.startSpan)
    assert.strictEqual(duplicateStore, firstStore)
    assert.strictEqual(first.context.operationState.currentStore, firstStore)
  })

  it('times out only the selected concurrent invocation', () => {
    const firstToken = {}
    const secondToken = {}

    channels.invocationStart.runStores(startEvent(firstToken), () => {})
    channels.invocationStart.runStores(startEvent(secondToken), () => {})
    channels.invocationTimeout.publish({
      kind: 'serverless',
      operation: 'invocation',
      token: firstToken,
    })

    assert.strictEqual(spans[0].finished, true)
    assert.strictEqual(spans[1].finished, false)
  })
})

function startEvent (token, data = {}) {
  return {
    v: 1,
    kind: 'serverless',
    operation: 'invocation',
    phase: 'start',
    token,
    source: {
      platform: 'vercel',
      integration: 'vercel',
    },
    data,
  }
}

function createSpan (name, options) {
  return {
    name,
    options,
    tags: { ...options.tags },
    finished: false,
    finishCount: 0,
    addTags (tags) {
      Object.assign(this.tags, tags)
    },
    setTag (key, value) {
      this.tags[key] = value
    },
    finish (time) {
      this.finished = true
      this.finishTime = time
      this.finishCount++
    },
  }
}
