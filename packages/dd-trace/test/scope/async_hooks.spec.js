'use strict'

const { AsyncResource, executionAsyncId } = require('async_hooks')
const Scope = require('../../src/scope/async_hooks')
const Span = require('opentracing').Span
const metrics = require('../../src/metrics')
const testScope = require('./test')

wrapIt('async_hooks')

describe('Scope (async_hooks)', () => {
  let scope
  let span

  beforeEach(() => {
    sinon.spy(metrics, 'increment')
    sinon.spy(metrics, 'decrement')

    scope = new Scope({
      experimental: {}
    })

    span = new Span()
  })

  afterEach(() => {
    metrics.increment.restore()
    metrics.decrement.restore()
  })

  it('should keep track of asynchronous resource count', () => {
    scope._init(0, 'TEST')
    scope._destroy(0)

    expect(metrics.increment).to.have.been.calledWith('runtime.node.async.resources')
    expect(metrics.decrement).to.have.been.calledWith('runtime.node.async.resources')
  })

  it('should keep track of asynchronous resource count by type', () => {
    scope._init(0, 'TEST')
    scope._destroy(0)

    expect(metrics.increment).to.have.been.calledWith('runtime.node.async.resources.by.type', 'resource_type:TEST')
    expect(metrics.decrement).to.have.been.calledWith('runtime.node.async.resources.by.type', 'resource_type:TEST')
  })

  it('should only track destroys once', () => {
    scope._init(0, 'TEST')
    scope._destroy(0)
    scope._destroy(0)

    expect(metrics.decrement).to.have.been.calledTwice
    expect(metrics.decrement).to.have.been.calledWith('runtime.node.async.resources')
    expect(metrics.decrement).to.have.been.calledWith('runtime.node.async.resources.by.type')
  })

  it('should not break propagation for nested resources', done => {
    scope.activate(span, () => {
      const asyncResource = new AsyncResource(
        'TEST', { triggerAsyncId: executionAsyncId(), requireManualDestroy: false }
      )

      asyncResource.runInAsyncScope(() => {})

      expect(scope.active()).to.equal(span)

      done()
    })
  })

  describe('with a thenable', () => {
    let thenable
    let test

    beforeEach(() => {
      thenable = {
        then: onFulfill => onFulfill()
      }

      test = async () => {
        await thenable
      }
    })

    it('should not alter the active span when using await', () => {
      scope.bind(thenable)
      scope.activate(span, () => test())

      expect(scope.active()).to.be.null
    })

    it('should use the active span when using await', () => {
      thenable.then = onFulfill => {
        expect(scope.active()).to.equal(span)
        onFulfill()
      }

      scope.bind(thenable)
      return scope.activate(span, () => test())
    })

    it('should use the active span when using await in a timer', done => {
      thenable.then = onFulfill => {
        expect(scope.active()).to.equal(span)
        onFulfill()
      }

      test = async () => {
        setTimeout(async () => {
          try {
            await thenable
            done()
          } catch (e) {
            done(e)
          }
        })
      }

      scope.bind(thenable)
      scope.activate(span, () => test())
    })

    it('should use the active span when using await in nested scopes', () => {
      thenable.then = onFulfill => {
        expect(scope.active()).to.equal(span)
        onFulfill()
      }

      scope.bind(thenable)
      return scope.activate({}, async () => {
        return scope.activate(span, () => test())
      })
    })

    it('should use the active span when using nested awaits', async () => {
      return scope.activate(span, async () => {
        await thenable

        thenable.then = (onFulfill, onReject) => {
          try {
            expect()
            onFulfill()
          } catch (e) {
            onReject(e)
          }
        }

        await thenable
      })
    })
  })

  testScope(() => scope)
})
