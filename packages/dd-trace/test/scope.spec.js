'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { Span } = require('opentracing')
const { storage } = require('../../datadog-core')
require('./setup/core')
const {
  createStoreRetirement,
  enterSpanForRetirement,
} = require('../src/active-span')
const Scope = require('../src/scope')

const legacyStorage = storage('legacy')

describe('Scope', () => {
  let scope
  let span

  beforeEach(() => {
    scope = new Scope()
    span = new Span()
  })

  afterEach(() => {
    legacyStorage.enterWith(undefined)
  })

  describe('active()', () => {
    it('should return null by default', () => {
      assert.strictEqual(scope.active(), null)
    })

    it('should return one retired span for the active context', () => {
      const context = { _baggageItems: {}, _trace: { started: [] } }
      const tracer = {}
      const activeSpan = {
        _duration: 1,
        context: () => context,
        tracer: () => tracer,
      }
      const retirement = createStoreRetirement()
      enterSpanForRetirement(activeSpan, {}, retirement)
      retirement.retire()

      scope = new Scope()
      const retiredSpan = scope.active()

      assert.notStrictEqual(retiredSpan, activeSpan)
      assert.strictEqual(retiredSpan.context(), context)
      assert.strictEqual(scope.active(), retiredSpan)
    })
  })

  describe('activate()', () => {
    it('should return the value returned by the callback', () => {
      assert.strictEqual(scope.activate(span, () => 'test'), 'test')
    })

    it('should preserve the surrounding scope', () => {
      assert.strictEqual(scope.active(), null)

      scope.activate(span, () => {})

      assert.strictEqual(scope.active(), null)
    })

    it('should support an invalid callback', () => {
      scope.activate(span, 'invalid')
    })

    it('should activate the span on the current scope', () => {
      assert.strictEqual(scope.active(), null)

      scope.activate(span, () => {
        assert.strictEqual(scope.active(), span)
      })

      assert.strictEqual(scope.active(), null)
    })

    it('should persist through setTimeout', done => {
      scope.activate(span, () => {
        setTimeout(() => {
          assert.strictEqual(scope.active(), span)
          done()
        }, 0)
      })
    })

    it('should persist through setImmediate', done => {
      scope.activate(span, () => {
        setImmediate(() => {
          assert.strictEqual(scope.active(), span)
          done()
        }, 0)
      })
    })

    it('should persist through setInterval', done => {
      scope.activate(span, () => {
        let shouldReturn = false

        const timer = setInterval(() => {
          assert.strictEqual(scope.active(), span)

          if (shouldReturn) {
            clearInterval(timer)
            return done()
          }

          shouldReturn = true
        }, 0)
      })
    })

    it('should persist through process.nextTick', done => {
      scope.activate(span, () => {
        process.nextTick(() => {
          assert.strictEqual(scope.active(), span)
          done()
        }, 0)
      })
    })

    it('should persist through promises', () => {
      const promise = Promise.resolve()

      return scope.activate(span, () => {
        return promise.then(() => {
          assert.strictEqual(scope.active(), span)
        })
      })
    })

    it('should handle concurrency', done => {
      scope.activate(span, () => {
        setImmediate(() => {
          assert.strictEqual(scope.active(), span)
          done()
        })
      })

      scope.activate(span, () => {})
    })

    it('should handle errors', () => {
      const error = new Error('boom')

      sinon.spy(span, 'setTag')

      try {
        scope.activate(span, () => {
          throw error
        })
      } catch (e) {
        sinon.assert.calledWith(span.setTag, 'error', e)
      }
    })

    it('should activate a retired span without restoring its original parent', () => {
      const context = { _baggageItems: {}, _trace: { started: [] } }
      const tracer = {}
      const activeSpan = {
        _duration: 1,
        context: () => context,
        tracer: () => tracer,
      }
      const retirement = createStoreRetirement()
      enterSpanForRetirement(activeSpan, {}, retirement)
      retirement.retire()

      scope = new Scope()
      const retiredSpan = scope.active()

      scope.activate(retiredSpan, () => {
        assert.strictEqual(scope.active(), retiredSpan)
      })
    })

    it('should suppress a retired span when activating null', () => {
      const context = { _baggageItems: {}, _trace: { started: [] } }
      const tracer = {}
      const activeSpan = {
        _duration: 1,
        context: () => context,
        tracer: () => tracer,
      }
      const retirement = createStoreRetirement()
      enterSpanForRetirement(activeSpan, {}, retirement)
      retirement.retire()

      scope = new Scope()
      scope.activate(null, () => {
        assert.strictEqual(scope.active(), null)
      })
    })

    it('should preserve an explicitly activated original span after retirement', () => {
      const context = { _baggageItems: {}, _trace: { started: [] } }
      const tracer = {}
      const activeSpan = {
        _duration: 1,
        context: () => context,
        tracer: () => tracer,
      }
      const retirement = createStoreRetirement()
      enterSpanForRetirement(activeSpan, {}, retirement)
      retirement.retire()

      scope = new Scope()
      scope.activate(activeSpan, () => {
        assert.strictEqual(scope.active(), activeSpan)
      })
    })
  })

  describe('bind()', () => {
    describe('with a function', () => {
      it('should bind the function to the active span', () => {
        let fn = () => {
          assert.strictEqual(scope.active(), span)
        }

        scope.activate(span, () => {
          fn = scope.bind(fn)
        })

        fn()
      })

      it('should bind the function to the provided span', () => {
        let fn = () => {
          assert.strictEqual(scope.active(), span)
        }

        fn = scope.bind(fn, span)

        fn()
      })

      it('should keep the return value', () => {
        let fn = () => 'test'

        fn = scope.bind(fn)

        assert.strictEqual(fn(), 'test')
      })

      it('should observe retirement after binding the active context', () => {
        const context = { _baggageItems: {}, _trace: { started: [] } }
        const tracer = {}
        const activeSpan = {
          _duration: 1,
          context: () => context,
          tracer: () => tracer,
        }
        const retirement = createStoreRetirement()
        enterSpanForRetirement(activeSpan, {}, retirement)

        scope = new Scope()
        const fn = scope.bind(() => scope.active())
        retirement.retire()

        assert.notStrictEqual(fn(), activeSpan)
        assert.strictEqual(fn().context(), context)
      })

      it('should tag errors thrown from an implicitly bound retireable context', () => {
        const error = new Error('boom')
        const activeSpan = {
          setTag: sinon.spy(),
        }
        enterSpanForRetirement(activeSpan, {}, createStoreRetirement())
        const fn = scope.bind(() => {
          throw error
        })

        assert.throws(fn, error)
        sinon.assert.calledWith(activeSpan.setTag, 'error', error)
      })
    })

    describe('with an unsupported target', () => {
      it('should return the target', () => {
        assert.strictEqual(scope.bind('test', span), 'test')
      })
    })
  })
})
