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

  describe('bind()', () => {
    describe('with a function', () => {
      it('should bind the function to the active span', () => {
        let fn = () => {
          expect(scope.active()).to.equal(span)
        }

        scope.activate(span, () => {
          fn = scope.bind(fn)
        })

        fn()
      })

      it('should bind the function to the provided span', () => {
        let fn = () => {
          expect(scope.active()).to.equal(span)
        }

        fn = scope.bind(fn, span)

        fn()
      })

      it('should keep the return value', () => {
        let fn = () => 'test'

        fn = scope.bind(fn)

        expect(fn()).to.equal('test')
      })
    })

    describe('with a promise', () => {
      let promise

      beforeEach(() => {
        promise = Promise.resolve()
      })

      it('should bind the promise to the active span', () => {
        return scope.activate(span, () => {
          scope.bind(promise)

          return promise.then(() => {
            expect(scope.active()).to.equal(span)
          })
        })
      })

      it('should bind the function to the provided span', () => {
        scope.bind(promise, span)

        return promise.then(() => {
          expect(scope.active()).to.equal(span)
        })
      })

      it('should return the promise', () => {
        expect(scope.bind(promise, span)).to.equal(promise)
      })
    })

    describe('with an event emitter', () => {
      let emitter

      beforeEach(() => {
        const events = require('events')
        emitter = new events.EventEmitter()
      })

      it('should bind listeners to the active span', done => {
        scope.activate(span, () => {
          scope.bind(emitter)

          emitter.on('test', () => {
            expect(scope.active()).to.equal(span)
            done()
          })
        })

        emitter.emit('test')
      })

      it('should bind the function to the provided span', done => {
        scope.bind(emitter, span)

        emitter.on('test', () => {
          expect(scope.active()).to.equal(span)
          done()
        })

        emitter.emit('test')
      })

      it('should return the emitter', () => {
        expect(scope.bind(emitter, span)).to.equal(emitter)
      })

      it('should support reusing listeners', done => {
        const spans = []
        const listener = () => {
          spans.push(scope.active())
        }

        scope.bind(emitter)

        scope.activate(span, () => {
          emitter.on('test', listener)

          scope.activate(null, () => {
            emitter.on('test', listener)
          })
        })

        emitter.on('test', () => {
          try {
            expect(spans[0]).to.equal(span)
            expect(spans[1]).to.be.null
            done()
          } catch (e) {
            done(e)
          }
        })

        emitter.emit('test')
      })
    })

    describe('with an unsupported target', () => {
      it('should return the target', () => {
        expect(scope.bind('test', span)).to.equal('test')
      })
    })
  })
})
