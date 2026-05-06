'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

const { Span } = require('../../../vendor/dist/opentracing')
require('./setup/core')
const Scope = require('../src/scope')
const { isUserVisible } = require('../src/user_visibility')

describe('Scope', () => {
  let scope
  let span

  beforeEach(() => {
    scope = new Scope()
    span = new Span()
  })

  describe('active()', () => {
    it('should return null by default', () => {
      assert.strictEqual(scope.active(), null)
    })

    it('marks the returned span as user-visible', () => {
      scope.activate(span, () => {
        const active = scope.active()
        assert.strictEqual(active, span)
        assert.equal(isUserVisible(active), true)
      })
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

    it('marks the activated span as user-visible', () => {
      scope.activate(span, () => {})
      assert.equal(isUserVisible(span), true)
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

      it('marks the bound span as user-visible', () => {
        scope.bind(() => {}, span)
        assert.equal(isUserVisible(span), true)
      })
    })

    describe('with an unsupported target', () => {
      it('should return the target', () => {
        assert.strictEqual(scope.bind('test', span), 'test')
      })
    })
  })
})
