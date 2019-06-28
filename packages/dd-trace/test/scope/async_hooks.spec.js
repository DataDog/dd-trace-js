'use strict'

const semver = require('semver')
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

  it('should only track promise destroys once', () => {
    scope._init(0, 'TEST')
    scope._promiseResolve(0)
    scope._destroy(0)

    expect(metrics.decrement).to.have.been.calledTwice
    expect(metrics.decrement).to.have.been.calledWith('async.resources')
    expect(metrics.decrement).to.have.been.calledWith('async.resources.by.type')
  })

  it('should have a safeguard against async resource leaks', done => {
    const span = {}

    scope.activate(span, () => {
      setImmediate(() => {
        expect(scope.active()).to.be.null
        done()
      })

      scope._wipe(span)
    })
  })

  it('should preserve the current scope even with the memory leak safeguard', done => {
    const parent = {}
    const child = {}

    scope.activate(parent, () => {
      setImmediate(() => {
        scope.activate(child, () => {
          scope._wipe(parent)

          expect(scope.active()).to.equal(child)
          done()
        })
      })
    })
  })

  if (!semver.satisfies(process.version, '^8.13 || >=10.14.2')) {
    it('should work around the HTTP keep-alive bug in Node', () => {
      const resource = {}

      sinon.spy(scope, '_delete')

      scope._init(1, 'TCPWRAP', 0, resource)
      scope._init(1, 'TCPWRAP', 0, resource)

      expect(scope._delete).to.have.been.called
    })
  }

  testScope(() => scope)
})
