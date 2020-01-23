'use strict'

const Span = require('opentracing').Span
const Config = require('../src/config')
const tags = require('../../../ext/tags')

const SPAN_TYPE = tags.SPAN_TYPE
const RESOURCE_NAME = tags.RESOURCE_NAME
const SERVICE_NAME = tags.SERVICE_NAME
const ANALYTICS = tags.ANALYTICS

wrapIt()

describe('Tracer', () => {
  let Tracer
  let tracer
  let config
  let instrumenter
  let Instrumenter

  beforeEach(() => {
    config = new Config('test', { service: 'service' })

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
        service: 'service',
        resource: 'resource',
        type: 'type',
        tags: {
          foo: 'bar'
        }
      }

      tracer.trace('name', options, span => {
        expect(span).to.be.instanceof(Span)
        expect(span.context()._tags).to.include(options.tags)
        expect(span.context()._tags).to.include({
          [SERVICE_NAME]: 'service',
          [RESOURCE_NAME]: 'resource',
          [SPAN_TYPE]: 'type'
        })
      })
    })

    it('should support analytics', () => {
      tracer.trace('name', { analytics: 0.5 }, span => {
        expect(span.context()._tags).to.have.property(ANALYTICS, 0.5)
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
          expect(span.context()._parentId.toString(10)).to.equal(childOf.context().toSpanId())
        })
      })
    })

    it('should allow overriding the parent span', () => {
      const root = tracer.startSpan('root')
      const childOf = tracer.startSpan('parent')

      tracer.scope().activate(root, () => {
        tracer.trace('name', { childOf }, span => {
          expect(span.context()._parentId.toString(10)).to.equal(childOf.context().toSpanId())
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
      let tags

      try {
        tracer.trace('name', {}, _span => {
          span = _span
          tags = span.context()._tags
          sinon.spy(span, 'finish')
          throw new Error('boom')
        })
      } catch (e) {
        expect(span.finish).to.have.been.called
        expect(tags).to.include({
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
        let tags
        let done

        tracer.trace('name', {}, (_span, _done) => {
          span = _span
          tags = span.context()._tags
          sinon.spy(span, 'finish')
          done = _done
        })

        done(error)

        expect(span.finish).to.have.been.called
        expect(tags).to.include({
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
        let tags

        tracer
          .trace('name', {}, _span => {
            span = _span
            tags = span.context()._tags
            sinon.spy(span, 'finish')
            return Promise.reject(new Error('boom'))
          })
          .catch(e => {
            expect(span.finish).to.have.been.called
            expect(tags).to.include({
              'error.type': e.name,
              'error.msg': e.message,
              'error.stack': e.stack
            })
            done()
          })
          .catch(done)
      })
    })

    describe('when there is no parent span', () => {
      it('should not trace if `orphanable: false`', () => {
        sinon.spy(tracer, 'startSpan')

        tracer.trace('name', { orphanable: false }, () => {})

        expect(tracer.startSpan).to.have.not.been.called
      })

      it('should trace if `orphanable: true`', () => {
        sinon.spy(tracer, 'startSpan')

        tracer.trace('name', { orhpanable: true }, () => {})

        expect(tracer.startSpan).to.have.been.called
      })

      it('should trace if `orphanable: undefined`', () => {
        sinon.spy(tracer, 'startSpan')

        tracer.trace('name', {}, () => {})

        expect(tracer.startSpan).to.have.been.called
      })
    })

    describe('when there is a parent span', () => {
      it('should trace if `orphanable: false`', () => {
        tracer.scope().activate(tracer.startSpan('parent'), () => {
          sinon.spy(tracer, 'startSpan')

          tracer.trace('name', { orhpanable: false }, () => {})

          expect(tracer.startSpan).to.have.been.called
        })
      })

      it('should trace if `orphanable: true`', () => {
        tracer.scope().activate(tracer.startSpan('parent'), () => {
          sinon.spy(tracer, 'startSpan')

          tracer.trace('name', { orphanable: true }, () => {})

          expect(tracer.startSpan).to.have.been.called
        })
      })

      it('should trace if `orphanable: undefined`', () => {
        tracer.scope().activate(tracer.startSpan('parent'), () => {
          sinon.spy(tracer, 'startSpan')

          tracer.trace('name', {}, () => {})

          expect(tracer.startSpan).to.have.been.called
        })
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

    it('should wait for the callback to be called before finishing the span', done => {
      const fn = tracer.wrap('name', {}, sinon.spy(function (cb) {
        const span = tracer.scope().active()

        sinon.spy(span, 'finish')

        setImmediate(() => {
          expect(span.finish).to.not.have.been.called
        })

        setImmediate(() => cb())

        setImmediate(() => {
          expect(span.finish).to.have.been.called
          done()
        })
      }))

      sinon.spy(tracer, 'trace')

      fn(() => {})
    })

    it('should handle rejected promises', done => {
      const fn = tracer.wrap('name', {}, (cb) => cb())
      const catchHandler = sinon.spy(({ message }) => expect(message).to.equal('boom'))

      fn(() => Promise.reject(new Error('boom')))
        .catch(catchHandler)
        .then(() => expect(catchHandler).to.have.been.called)
        .then(() => done())
    })

    it('should accept an options object', () => {
      const options = { tags: { sometag: 'somevalue' } }

      const fn = tracer.wrap('name', options, function () {})

      sinon.spy(tracer, 'trace')

      fn('hello', 'goodbye')

      expect(tracer.trace).to.have.been.calledWith('name', {
        tags: { sometag: 'somevalue' }
      })
    })

    it('should accept an options function', () => {
      const it = {}

      function options (foo, bar) {
        expect(this).to.equal(it)
        expect(foo).to.equal('hello')
        expect(bar).to.equal('goodbye')
        return { tags: { sometag: 'somevalue' } }
      }

      const fn = tracer.wrap('name', options, function () {})

      sinon.spy(tracer, 'trace')

      fn.call(it, 'hello', 'goodbye')

      expect(tracer.trace).to.have.been.calledWith('name', {
        tags: { sometag: 'somevalue' }
      })
    })

    describe('when there is no parent span', () => {
      it('should not trace if `orphanable: false`', () => {
        const fn = tracer.wrap('name', { orphanable: false }, () => {})

        sinon.spy(tracer, 'trace')

        fn()

        expect(tracer.trace).to.have.not.been.called
      })

      it('should trace if `orphanable: true`', () => {
        const fn = tracer.wrap('name', { orhpanable: true }, () => {})

        sinon.spy(tracer, 'trace')

        fn()

        expect(tracer.trace).to.have.been.called
      })

      it('should trace if `orphanable: undefined`', () => {
        const fn = tracer.wrap('name', {}, () => {})

        sinon.spy(tracer, 'trace')

        fn()

        expect(tracer.trace).to.have.been.called
      })
    })

    describe('when there is a parent span', () => {
      it('should trace if `orphanable: false`', () => {
        tracer.scope().activate(tracer.startSpan('parent'), () => {
          const fn = tracer.wrap('name', { orhpanable: false }, () => {})

          sinon.spy(tracer, 'trace')

          fn()

          expect(tracer.trace).to.have.been.called
        })
      })

      it('should trace if `orphanable: true`', () => {
        tracer.scope().activate(tracer.startSpan('parent'), () => {
          const fn = tracer.wrap('name', { orphanable: true }, () => {})

          sinon.spy(tracer, 'trace')

          fn()

          expect(tracer.trace).to.have.been.called
        })
      })

      it('should trace if `orphanable: undefined`', () => {
        tracer.scope().activate(tracer.startSpan('parent'), () => {
          const fn = tracer.wrap('name', {}, () => {})

          sinon.spy(tracer, 'trace')

          fn()

          expect(tracer.trace).to.have.been.called
        })
      })
    })
  })
})
