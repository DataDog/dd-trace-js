'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { withDatadogServerAction } = require('../src/server-action')

describe('withDatadogServerAction', () => {
  let tracer
  let actionSpan
  let activeSpan

  beforeEach(() => {
    actionSpan = {
      finish: sinon.spy(),
      setTag: sinon.spy(),
    }
    activeSpan = { name: 'parent' }
    tracer = {
      startSpan: sinon.stub().returns(actionSpan),
      scope: sinon.stub().returns({
        active: sinon.stub().returns(activeSpan),
        activate: sinon.stub().callsFake((span, fn) => fn()),
      }),
    }
    global._ddtrace = tracer
  })

  afterEach(() => {
    delete global._ddtrace
  })

  it('should call action directly when tracer is not available', () => {
    delete global._ddtrace

    const action = sinon.stub().resolves('result')
    const result = withDatadogServerAction('myAction', action)

    assert.ok(result instanceof Promise)
    sinon.assert.calledOnce(action)
    sinon.assert.notCalled(tracer.startSpan)
  })

  it('should create a child span with action name and resource.name', () => {
    const action = sinon.stub().resolves('result')

    withDatadogServerAction('myAction', action)

    sinon.assert.calledOnce(tracer.startSpan)
    sinon.assert.calledWith(tracer.startSpan, 'myAction', {
      childOf: activeSpan,
      tags: {
        'resource.name': 'myAction',
        'span.kind': 'internal',
      },
    })
  })

  it('should activate the span and finish on success', () => {
    const action = sinon.stub().resolves('hello')

    return withDatadogServerAction('myAction', action).then((result) => {
      assert.equal(result, 'hello')
      sinon.assert.calledOnce(actionSpan.finish)
      sinon.assert.notCalled(actionSpan.setTag)
    })
  })

  it('should set error tag and finish span on rejection', () => {
    const err = new Error('boom')
    const action = sinon.stub().rejects(err)

    return withDatadogServerAction('failAction', action).then(
      () => assert.fail('should have thrown'),
      (thrown) => {
        assert.equal(thrown, err)
        sinon.assert.calledWith(actionSpan.setTag, 'error', err)
        sinon.assert.calledOnce(actionSpan.finish)
      }
    )
  })

  it('should activate the action span as the current scope', () => {
    const action = sinon.stub().resolves()
    const scope = tracer.scope()

    withDatadogServerAction('myAction', action)

    sinon.assert.calledOnce(scope.activate)
    sinon.assert.calledWith(scope.activate, actionSpan, sinon.match.func)
  })
})
