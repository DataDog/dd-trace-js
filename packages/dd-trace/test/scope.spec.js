'use strict'

const t = require('tap')
require('./setup/core')

const Span = require('opentracing').Span
const Scope = require('../src/scope')

t.test('Scope', t => {
  let scope
  let span

  t.beforeEach(() => {
    scope = new Scope()
    span = new Span()
  })

  t.test('active()', t => {
    t.test('should return null by default', t => {
      expect(scope.active()).to.be.null
      t.end()
    })
    t.end()
  })

  t.test('activate()', t => {
    t.test('should return the value returned by the callback', t => {
      expect(scope.activate(span, () => 'test')).to.equal('test')
      t.end()
    })

    t.test('should preserve the surrounding scope', t => {
      expect(scope.active()).to.be.null

      scope.activate(span, () => {})

      expect(scope.active()).to.be.null
      t.end()
    })

    t.test('should support an invalid callback', t => {
      expect(() => { scope.activate(span, 'invalid') }).to.not.throw(Error)
      t.end()
    })

    t.test('should activate the span on the current scope', t => {
      expect(scope.active()).to.be.null

      scope.activate(span, () => {
        expect(scope.active()).to.equal(span)
      })

      expect(scope.active()).to.be.null
      t.end()
    })

    t.test('should persist through setTimeout', t => {
      scope.activate(span, () => {
        setTimeout(() => {
          expect(scope.active()).to.equal(span)
          t.end()
        }, 0)
      })
    })

    t.test('should persist through setImmediate', t => {
      scope.activate(span, () => {
        setImmediate(() => {
          expect(scope.active()).to.equal(span)
          t.end()
        }, 0)
      })
    })

    t.test('should persist through setInterval', t => {
      scope.activate(span, () => {
        let shouldReturn = false

        const timer = setInterval(() => {
          expect(scope.active()).to.equal(span)

          if (shouldReturn) {
            clearInterval(timer)
            return t.end()
          }

          shouldReturn = true
        }, 0)
      })
    })

    t.test('should persist through process.nextTick', t => {
      scope.activate(span, () => {
        process.nextTick(() => {
          expect(scope.active()).to.equal(span)
          t.end()
        }, 0)
      })
    })

    t.test('should persist through promises', t => {
      const promise = Promise.resolve()

      return scope.activate(span, () => {
        return promise.then(() => {
          expect(scope.active()).to.equal(span)
        })
      })
    })

    t.test('should handle concurrency', t => {
      scope.activate(span, () => {
        setImmediate(() => {
          expect(scope.active()).to.equal(span)
          t.end()
        })
      })

      scope.activate(span, () => {})
    })

    t.test('should handle errors', t => {
      const error = new Error('boom')

      sinon.spy(span, 'setTag')

      try {
        scope.activate(span, () => {
          throw error
        })
      } catch (e) {
        expect(span.setTag).to.have.been.calledWith('error', e)
      }
      t.end()
    })
    t.end()
  })

  t.test('bind()', t => {
    t.test('with a function', t => {
      t.test('should bind the function to the active span', t => {
        let fn = () => {
          expect(scope.active()).to.equal(span)
        }

        scope.activate(span, () => {
          fn = scope.bind(fn)
        })

        fn()
        t.end()
      })

      t.test('should bind the function to the provided span', t => {
        let fn = () => {
          expect(scope.active()).to.equal(span)
        }

        fn = scope.bind(fn, span)

        fn()
        t.end()
      })

      t.test('should keep the return value', t => {
        let fn = () => 'test'

        fn = scope.bind(fn)

        expect(fn()).to.equal('test')
        t.end()
      })
      t.end()
    })

    t.test('with an unsupported target', t => {
      t.test('should return the target', t => {
        expect(scope.bind('test', span)).to.equal('test')
        t.end()
      })
      t.end()
    })
    t.end()
  })
  t.end()
})
