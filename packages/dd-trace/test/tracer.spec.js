'use strict'

const t = require('tap')
require('./setup/core')

const Span = require('../src/opentracing/span')
const Config = require('../src/config')
const tags = require('../../../ext/tags')
const { expect } = require('chai')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const SPAN_TYPE = tags.SPAN_TYPE
const RESOURCE_NAME = tags.RESOURCE_NAME
const SERVICE_NAME = tags.SERVICE_NAME
const EXPORT_SERVICE_NAME = 'service'
const BASE_SERVICE = tags.BASE_SERVICE

t.test('Tracer', t => {
  let Tracer
  let tracer
  let config
  let instrumenter
  let Instrumenter
  let tracerConfigureCh

  t.beforeEach(() => {
    config = new Config({ service: 'service' })

    instrumenter = {
      use: sinon.spy(),
      patch: sinon.spy()
    }
    Instrumenter = sinon.stub().returns(instrumenter)

    tracerConfigureCh = {
      publish: sinon.stub()
    }

    const channels = {
      'datadog:tracer:configure': tracerConfigureCh
    }

    Tracer = proxyquire('../src/tracer', {
      'dc-polyfill': {
        channel: (name) => channels[name]
      },
      './instrumenter': Instrumenter
    })

    tracer = new Tracer(config)
    tracer._exporter.setUrl = sinon.stub()
    tracer._exporter.export = sinon.stub()
    tracer._prioritySampler.configure = sinon.stub()
  })

  t.test('configure', t => {
    t.test('should pass the sampling options to the priority sampler', t => {
      const env = 'test'
      const sampler = { sampleRate: 0.5 }
      const options = { env, sampler }
      tracer.configure(options)
      expect(tracer._prioritySampler.configure).to.have.been.calledWith(env, sampler)
      t.end()
    })
    t.end()
  })

  t.test('setUrl', t => {
    t.test('should pass the setUrl call to the exporter', t => {
      tracer.setUrl('http://example.com')
      expect(tracer._exporter.setUrl).to.have.been.calledWith('http://example.com')
      t.end()
    })
    t.end()
  })

  t.test('trace', t => {
    t.test('should run the callback with a new span', t => {
      tracer.trace('name', {}, span => {
        expect(span).to.be.instanceof(Span)
        expect(span.context()._name).to.equal('name')
      })
      t.end()
    })

    t.test('should accept options', t => {
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
      t.end()
    })

    t.test('_dd.base_service', t => {
      t.test('should be set when tracer.trace service mismatches configured service', t => {
        tracer.trace('name', { service: 'custom' }, () => {})
        const trace = tracer._exporter.export.getCall(0).args[0][0]
        expect(trace).to.have.property(EXPORT_SERVICE_NAME, 'custom')
        expect(trace.meta).to.have.property(BASE_SERVICE, 'service')
        t.end()
      })

      t.test('should not be set when tracer.trace service is not supplied', t => {
        tracer.trace('name', {}, () => {})
        const trace = tracer._exporter.export.getCall(0).args[0][0]
        expect(trace).to.have.property(EXPORT_SERVICE_NAME, 'service')
        expect(trace.meta).to.not.have.property(BASE_SERVICE)
        t.end()
      })

      t.test('should not be set when tracer.trace service matched configured service', t => {
        tracer.trace('name', { service: 'service' }, () => {})
        const trace = tracer._exporter.export.getCall(0).args[0][0]
        expect(trace).to.have.property(EXPORT_SERVICE_NAME, 'service')
        expect(trace.meta).to.not.have.property(BASE_SERVICE)
        t.end()
      })
      t.end()
    })

    t.test('should activate the span', t => {
      tracer.trace('name', {}, span => {
        expect(tracer.scope().active()).to.equal(span)
      })
      t.end()
    })

    t.test('should start the span as a child of the active span', t => {
      const childOf = tracer.startSpan('parent')

      tracer.scope().activate(childOf, () => {
        tracer.trace('name', {}, span => {
          expect(span.context()._parentId.toString(10)).to.equal(childOf.context().toSpanId())
        })
      })
      t.end()
    })

    t.test('should allow overriding the parent span', t => {
      const root = tracer.startSpan('root')
      const childOf = tracer.startSpan('parent')

      tracer.scope().activate(root, () => {
        tracer.trace('name', { childOf }, span => {
          expect(span.context()._parentId.toString(10)).to.equal(childOf.context().toSpanId())
        })
      })
      t.end()
    })

    t.test('should return the value from the callback', t => {
      const result = tracer.trace('name', {}, span => 'test')

      expect(result).to.equal('test')
      t.end()
    })

    t.test('should finish the span', t => {
      let span

      tracer.trace('name', {}, (_span) => {
        span = _span
        sinon.spy(span, 'finish')
      })

      expect(span.finish).to.have.been.called
      t.end()
    })

    t.test('should handle exceptions', t => {
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
          [ERROR_TYPE]: e.name,
          [ERROR_MESSAGE]: e.message,
          [ERROR_STACK]: e.stack
        })
      }
      t.end()
    })

    t.test('with a callback taking a callback', t => {
      t.test('should wait for the callback to be called before finishing the span', t => {
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

        t.end()
      })

      t.test('should handle errors', t => {
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
          [ERROR_TYPE]: error.name,
          [ERROR_MESSAGE]: error.message,
          [ERROR_STACK]: error.stack
        })
        t.end()
      })
      t.end()
    })

    t.test('with a callback returning a promise', t => {
      t.test('should wait for the promise to resolve before finishing the span', t => {
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
            t.end()
          })
          .catch(t.error)

        expect(span.finish).to.not.have.been.called

        deferred.resolve()
      })

      t.test('should handle rejected promises', t => {
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
              [ERROR_TYPE]: e.name,
              [ERROR_MESSAGE]: e.message,
              [ERROR_STACK]: e.stack
            })
            t.end()
          })
          .catch(t.error)
      })

      t.skip('should not treat rejections as handled', t => {
        const err = new Error('boom')

        tracer
          .trace('name', {}, () => {
            return Promise.reject(err)
          })

        process.once('unhandledRejection', (received) => {
          expect(received).to.equal(err)
          t.end()
        })
      })
      t.end()
    })
    t.end()
  })

  t.test('getRumData', t => {
    t.beforeEach(() => {
      const now = Date.now()
      sinon.stub(Date, 'now').returns(now)
    })

    t.afterEach(() => {
      Date.now.restore()
    })

    t.test('should be disabled by default', t => {
      tracer.trace('getRumData', {}, () => {
        expect(tracer.getRumData()).to.equal('')
      })
      t.end()
    })

    t.test('should return correct string', t => {
      tracer._enableGetRumData = true
      tracer.trace('getRumData', {}, () => {
        const data = tracer.getRumData()
        const time = Date.now()
        const re = /<meta name="dd-trace-id" content="([\d\w]+)" \/><meta name="dd-trace-time" content="(\d+)" \/>/
        const [, traceId, traceTime] = re.exec(data)
        const span = tracer.scope().active().context()
        expect(traceId).to.equal(span.toTraceId())
        expect(traceTime).to.equal(time.toString())
      })
      t.end()
    })
    t.end()
  })

  t.test('wrap', t => {
    t.test('should return a new function that automatically calls tracer.trace()', t => {
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
      t.end()
    })

    t.test('should wait for the callback to be called before finishing the span', t => {
      const fn = tracer.wrap('name', {}, sinon.spy(function (cb) {
        const span = tracer.scope().active()

        sinon.spy(span, 'finish')

        setImmediate(() => {
          expect(span.finish).to.not.have.been.called
        })

        setImmediate(() => cb())

        setImmediate(() => {
          expect(span.finish).to.have.been.called
          t.end()
        })
      }))

      sinon.spy(tracer, 'trace')

      fn(() => {})
    })

    t.test('should handle rejected promises', t => {
      const fn = tracer.wrap('name', {}, (cb) => cb())
      const catchHandler = sinon.spy(({ message }) => expect(message).to.equal('boom'))

      fn(() => Promise.reject(new Error('boom')))
        .catch(catchHandler)
        .then(() => expect(catchHandler).to.have.been.called)
        .then(() => t.end())
    })

    t.test('should accept an options object', t => {
      const options = { tags: { sometag: 'somevalue' } }

      const fn = tracer.wrap('name', options, function () {})

      sinon.spy(tracer, 'trace')

      fn('hello', 'goodbye')

      expect(tracer.trace).to.have.been.calledWith('name', {
        tags: { sometag: 'somevalue' }
      })
      t.end()
    })

    t.test('should accept an options function, invoked on every invocation of the wrapped function', t => {
      const it = {}

      let invocations = 0

      function options (foo, bar) {
        invocations++
        expect(this).to.equal(it)
        expect(foo).to.equal('hello')
        expect(bar).to.equal('goodbye')
        return { tags: { sometag: 'somevalue', invocations } }
      }

      const fn = tracer.wrap('name', options, function () {})

      sinon.spy(tracer, 'trace')

      fn.call(it, 'hello', 'goodbye')

      expect(tracer.trace).to.have.been.calledWith('name', {
        tags: { sometag: 'somevalue', invocations: 1 }
      })

      fn.call(it, 'hello', 'goodbye')

      expect(tracer.trace).to.have.been.calledWith('name', {
        tags: { sometag: 'somevalue', invocations: 2 }
      })
      t.end()
    })
    t.end()
  })
  t.end()
})
