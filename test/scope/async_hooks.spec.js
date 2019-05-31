'use strict'

const Scope = require('../../src/scope/async_hooks')
const platform = require('../../src/platform')
const testScope = require('./test')

wrapIt()

describe('Scope', () => {
  let scope
  let metrics

  beforeEach(() => {
    metrics = platform.metrics()

    sinon.spy(metrics, 'increment')
    sinon.spy(metrics, 'decrement')

    scope = new Scope()
  })

  afterEach(() => {
    metrics.increment.restore()
    metrics.decrement.restore()
  })

  it('should keep track of asynchronous resource count', () => {
    scope._init(0, 'TEST')
    scope._destroy(0)

    expect(metrics.increment).to.have.been.calledWith('async.resources')
    expect(metrics.decrement).to.have.been.calledWith('async.resources')
  })

  it('should keep track of asynchronous resource count by type', () => {
    scope._init(0, 'TEST')
    scope._destroy(0)

    expect(metrics.increment).to.have.been.calledWith('async.resources.by.type', 'resource_type:TEST')
    expect(metrics.decrement).to.have.been.calledWith('async.resources.by.type', 'resource_type:TEST')
  })

  it('should only track destroys once', () => {
    scope._init(0, 'TEST')
    scope._destroy(0)
    scope._destroy(0)

    expect(metrics.decrement).to.have.been.calledTwice
    expect(metrics.decrement).to.have.been.calledWith('async.resources')
    expect(metrics.decrement).to.have.been.calledWith('async.resources.by.type')
  })

  it('should work around the HTTP keep-alive bug in Node', () => {
    const resource = {}

    sinon.spy(scope, '_destroy')

    scope._init(1, 'TCPWRAP', 0, resource)
    scope._init(1, 'TCPWRAP', 0, resource)

    expect(scope._destroy).to.have.been.called
  })

  testScope(() => scope)
})
