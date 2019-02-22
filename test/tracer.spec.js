'use strict'

const Span = require('opentracing').Span
const Config = require('../src/config')

wrapIt()

describe('Tracer', () => {
  let Tracer
  let tracer
  let config
  let instrumenter
  let Instrumenter

  beforeEach(() => {
    config = new Config({ service: 'service' })

    instrumenter = {
      use: sinon.spy(),
      patch: sinon.spy()
    }
    Instrumenter = sinon.stub().returns(instrumenter)

    Tracer = proxyquire('../src/tracer', {
      './instrumenter': Instrumenter
    })

    tracer = new Tracer(config)
  })

  describe('trace', () => {
    it('should run the callback with a new span', () => {
      tracer.trace('name', {}, span => {
        expect(span).to.be.instanceof(Span)
        expect(span.context()._name).to.equal('name')
      })
    })

    it('should accept options', () => {
      const options = {
        tags: {
          foo: 'bar'
        }
      }

      tracer.trace('name', options, span => {
        expect(span).to.be.instanceof(Span)
        expect(span.context()._tags).to.include(options.tags)
      })
    })

    it('should activate the span', () => {
      tracer.trace('name', {}, span => {
        expect(tracer.scope().active()).to.equal(span)
      })
    })

    it('should start the span as a child of the active span', () => {
      const childOf = tracer.startSpan('parent')

      tracer.scope().activate(childOf, () => {
        tracer.trace('name', {}, span => {
          expect(span.context()._parentId.toString()).to.equal(childOf.context().toSpanId())
        })
      })
    })

    it('should allow overriding the parent span', () => {
      const root = tracer.startSpan('root')
      const childOf = tracer.startSpan('parent')

      tracer.scope().activate(root, () => {
        tracer.trace('name', { childOf }, span => {
          expect(span.context()._parentId.toString()).to.equal(childOf.context().toSpanId())
        })
      })
    })

    it('should return the value from the callback', () => {
      const result = tracer.trace('name', {}, span => 'test')

      expect(result).to.equal('test')
    })

    it('should finish the span', () => {
      let span

      tracer.trace('name', {}, (_span) => {
        span = _span
        sinon.spy(span, 'finish')
      })

      expect(span.finish).to.have.been.called
    })

    it('should handle exceptions', () => {
      let span

      try {
        tracer.trace('name', {}, _span => {
          span = _span
          sinon.spy(span, 'finish')
          throw new Error('boom')
        })
      } catch (e) {
        expect(span.finish).to.have.been.called
        expect(span.context()._tags).to.include({
          'error.type': e.name,
          'error.msg': e.message,
          'error.stack': e.stack
        })
      }
    })

    describe('with a callback taking a callback', () => {
      it('should wait for the callback to be called before finishing the span', () => {
        let span
        let done

        tracer.trace('name', {}, (_span, _done) => {
          span = _span
          sinon.spy(span, 'finish')
          done = _done
        })

        expect(span.finish).to.not.have.been.called

        done()

        expect(span.finish).to.have.been.called
      })

      it('should handle errors', () => {
        const error = new Error('boom')
        let span
        let done

        tracer.trace('name', {}, (_span, _done) => {
          span = _span
          sinon.spy(span, 'finish')
          done = _done
        })

        done(error)

        expect(span.finish).to.have.been.called
        expect(span.context()._tags).to.include({
          'error.type': error.name,
          'error.msg': error.message,
          'error.stack': error.stack
        })
      })
    })

    describe('with a callback returning a promise', () => {
      it('should wait for the promise to resolve before finishing the span', done => {
        const deferred = {}
        const promise = new Promise(resolve => {
          deferred.resolve = resolve
        })

        let span

        tracer
          .trace('name', {}, _span => {
            span = _span
            sinon.spy(span, 'finish')
            return promise
          })
          .then(() => {
            expect(span.finish).to.have.been.called
            done()
          })
          .catch(done)

        expect(span.finish).to.not.have.been.called

        deferred.resolve()
      })

      it('should handle rejected promises', done => {
        let span

        tracer
          .trace('name', {}, _span => {
            span = _span
            sinon.spy(span, 'finish')
            return Promise.reject(new Error('boom'))
          })
          .catch(e => {
            expect(span.finish).to.have.been.called
            expect(span.context()._tags).to.include({
              'error.type': e.name,
              'error.msg': e.message,
              'error.stack': e.stack
            })
            done()
          })
          .catch(done)
      })
    })
  })

  describe('wrap', () => {
    it('should return a new function that automatically calls tracer.trace()', () => {
      const it = {}
      const callback = sinon.spy(function (foo) {
        expect(tracer.scope().active()).to.not.be.null
        expect(this).to.equal(it)
        expect(foo).to.equal('foo')

        return 'test'
      })
      const fn = tracer.wrap('name', {}, callback)

      sinon.spy(tracer, 'trace')

      const result = fn.call(it, 'foo')

      expect(callback).to.have.been.called
      expect(tracer.trace).to.have.been.calledWith('name', {})
      expect(result).to.equal('test')
    })
  })

  describe('currentSpan', () => {
    it('should return a noop span', () => {
      expect(tracer.currentSpan()).to.not.be.null
    })
  })
})
