'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const { Span } = require('opentracing')

require('./setup/core')

const Scope = require('../src/scope')

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
  })

  describe('activate()', () => {
    it('should return the value returned by the callback', () => {
      expect(scope.activate(span, () => 'test')).to.equal('test')
    })

    it('should preserve the surrounding scope', () => {
      assert.strictEqual(scope.active(), null)

      scope.activate(span, () => {})

      assert.strictEqual(scope.active(), null)
    })

    it('should support an invalid callback', () => {
      expect(() => { scope.activate(span, 'invalid') }).to.not.throw(Error)
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
    })

    describe('with an unsupported target', () => {
      it('should return the target', () => {
        assert.strictEqual(scope.bind('test', span), 'test')
      })
    })
  })
})
