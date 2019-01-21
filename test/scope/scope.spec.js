'use strict'

const Scope = require('../../src/scope/new/scope')
const Span = require('opentracing').Span

wrapIt()

describe('Scope', () => {
  let scope
  let span

  beforeEach(() => {
    scope = new Scope()
    span = new Span()
  })

  describe('active()', () => {
    it('should return null by default', () => {
      expect(scope.active()).to.be.null
    })
  })

  describe('activate()', () => {
    it('should return the value returned by the callback', () => {
      expect(scope.activate(span, () => 'test')).to.equal('test')
    })

    it('should preserve the surrounding scope', () => {
      expect(scope.active()).to.be.null

      scope.activate(span, () => {})

      expect(scope.active()).to.be.null
    })

    it('should support an invalid callback', () => {
      expect(() => { scope.activate(span, 'invalid') }).to.not.throw(Error)
    })

    it('should activate the span on the current scope', () => {
      expect(scope.active()).to.be.null

      scope.activate(span, () => {
        expect(scope.active()).to.equal(span)
      })

      expect(scope.active()).to.be.null
    })

    it('should persist through setTimeout', done => {
      scope.activate(span, () => {
        setTimeout(() => {
          expect(scope.active()).to.equal(span)
          done()
        }, 0)
      })
    })

    it('should persist through setImmediate', done => {
      scope.activate(span, () => {
        setImmediate(() => {
          expect(scope.active()).to.equal(span)
          done()
        }, 0)
      })
    })

    it('should persist through setInterval', done => {
      scope.activate(span, () => {
        let shouldReturn = false

        const timer = setInterval(() => {
          expect(scope.active()).to.equal(span)

          if (shouldReturn) {
            clearInterval(timer)
            return done()
          }

          shouldReturn = true
        }, 0)
      })
    })

    if (global.process && global.process.nextTick) {
      it('should persist through process.nextTick', done => {
        scope.activate(span, () => {
          process.nextTick(() => {
            expect(scope.active()).to.equal(span)
            done()
          }, 0)
        })
      })
    }

    it('should persist through promises', () => {
      const promise = Promise.resolve()

      return scope.activate(span, () => {
        return promise.then(() => {
          expect(scope.active()).to.equal(span)
        })
      })
    })

    it('should handle concurrency', done => {
      scope.activate(span, () => {
        setImmediate(() => {
          expect(scope.active()).to.equal(span)
          done()
        })
      })

      scope.activate(span, () => {})
    })
  })
})
