'use strict'

const assert = require('node:assert/strict')
const { assertObjectContains } = require('../../../integration-tests/helpers')

const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')

require('./setup/core')

const Tracer = require('../src/tracer')
const Span = require('../src/opentracing/span')
const getConfig = require('../src/config')
const tags = require('../../../ext/tags')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const SPAN_TYPE = tags.SPAN_TYPE
const RESOURCE_NAME = tags.RESOURCE_NAME
const SERVICE_NAME = tags.SERVICE_NAME
const EXPORT_SERVICE_NAME = 'service'
const BASE_SERVICE = tags.BASE_SERVICE

describe('Tracer', () => {
  let tracer
  let config

  beforeEach(() => {
    config = getConfig({ service: 'service' })

    tracer = new Tracer(config)
    tracer._exporter.setUrl = sinon.stub()
    tracer._exporter.export = sinon.stub()
    tracer._prioritySampler.configure = sinon.stub()
  })

  describe('configure', () => {
    it('should pass the sampling options to the priority sampler', () => {
      const env = 'test'
      const sampler = { sampleRate: 0.5 }
      const options = { env, sampler }
      tracer.configure(options)
      sinon.assert.calledWith(tracer._prioritySampler.configure, env, sampler)
    })
  })

  describe('setUrl', () => {
    it('should pass the setUrl call to the exporter', () => {
      tracer.setUrl('http://example.com')
      sinon.assert.calledWith(tracer._exporter.setUrl, 'http://example.com')
    })
  })

  describe('trace', () => {
    it('should run the callback with a new span', () => {
      tracer.trace('name', {}, span => {
        assert.ok(span instanceof Span)
        assert.strictEqual(span.context()._name, 'name')
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
        assert.ok(span instanceof Span)
        assertObjectContains(span.context()._tags, options.tags)
        assertObjectContains(span.context()._tags, {
          [SERVICE_NAME]: 'service',
          [RESOURCE_NAME]: 'resource',
          [SPAN_TYPE]: 'type'
        })
      })
    })

    describe('_dd.base_service', () => {
      it('should be set when tracer.trace service mismatches configured service', () => {
        tracer.trace('name', { service: 'custom' }, () => {})
        const trace = tracer._exporter.export.getCall(0).args[0][0]
        assert.strictEqual(trace[EXPORT_SERVICE_NAME], 'custom')
        assert.strictEqual(trace.meta[BASE_SERVICE], 'service')
      })

      it('should not be set when tracer.trace service is not supplied', () => {
        tracer.trace('name', {}, () => {})
        const trace = tracer._exporter.export.getCall(0).args[0][0]
        assert.strictEqual(trace[EXPORT_SERVICE_NAME], 'service')
        assert.ok(!(BASE_SERVICE in trace.meta))
      })

      it('should not be set when tracer.trace service matched configured service', () => {
        tracer.trace('name', { service: 'service' }, () => {})
        const trace = tracer._exporter.export.getCall(0).args[0][0]
        assert.strictEqual(trace[EXPORT_SERVICE_NAME], 'service')
        assert.ok(!(BASE_SERVICE in trace.meta))
      })
    })

    it('should activate the span', () => {
      tracer.trace('name', {}, span => {
        assert.strictEqual(tracer.scope().active(), span)
      })
    })

    it('should start the span as a child of the active span', () => {
      const childOf = tracer.startSpan('parent')

      tracer.scope().activate(childOf, () => {
        tracer.trace('name', {}, span => {
          assert.strictEqual(span.context()._parentId.toString(10), childOf.context().toSpanId())
        })
      })
    })

    it('should allow overriding the parent span', () => {
      const root = tracer.startSpan('root')
      const childOf = tracer.startSpan('parent')

      tracer.scope().activate(root, () => {
        tracer.trace('name', { childOf }, span => {
          assert.strictEqual(span.context()._parentId.toString(10), childOf.context().toSpanId())
        })
      })
    })

    it('should return the value from the callback', () => {
      const result = tracer.trace('name', {}, span => 'test')

      assert.strictEqual(result, 'test')
    })

    it('should finish the span', () => {
      let span

      tracer.trace('name', {}, (_span) => {
        span = _span
        sinon.spy(span, 'finish')
      })

      sinon.assert.called(span.finish)
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
        sinon.assert.called(span.finish)
        assertObjectContains(tags, {
          [ERROR_TYPE]: e.name,
          [ERROR_MESSAGE]: e.message,
          [ERROR_STACK]: e.stack
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

        sinon.assert.notCalled(span.finish)

        done()

        sinon.assert.called(span.finish)
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

        sinon.assert.called(span.finish)
        assertObjectContains(tags, {
          [ERROR_TYPE]: error.name,
          [ERROR_MESSAGE]: error.message,
          [ERROR_STACK]: error.stack
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
            sinon.assert.called(span.finish)
            done()
          })
          .catch(done)

        sinon.assert.notCalled(span.finish)

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
            sinon.assert.called(span.finish)
            assertObjectContains(tags, {
              [ERROR_TYPE]: e.name,
              [ERROR_MESSAGE]: e.message,
              [ERROR_STACK]: e.stack
            })
            done()
          })
          .catch(done)
      })

      it.skip('should not treat rejections as handled', done => {
        const err = new Error('boom')

        tracer
          .trace('name', {}, () => {
            return Promise.reject(err)
          })

        process.once('unhandledRejection', (received) => {
          assert.strictEqual(received, err)
          done()
        })
      })
    })
  })

  describe('getRumData', () => {
    beforeEach(() => {
      const now = Date.now()
      sinon.stub(Date, 'now').returns(now)
    })

    afterEach(() => {
      Date.now.restore()
    })

    it('should be disabled by default', () => {
      tracer.trace('getRumData', {}, () => {
        assert.strictEqual(tracer.getRumData(), '')
      })
    })

    it('should return correct string', () => {
      tracer._enableGetRumData = true
      tracer.trace('getRumData', {}, () => {
        const data = tracer.getRumData()
        const time = Date.now()
        const re = /<meta name="dd-trace-id" content="([\d\w]+)" \/><meta name="dd-trace-time" content="(\d+)" \/>/
        const [, traceId, traceTime] = re.exec(data)
        const span = tracer.scope().active().context()
        assert.strictEqual(traceId, span.toTraceId())
        assert.strictEqual(traceTime, time.toString())
      })
    })
  })

  describe('wrap', () => {
    it('should return a new function that automatically calls tracer.trace()', () => {
      const it = {}
      const callback = sinon.spy(function (foo) {
        assert.notStrictEqual(tracer.scope().active(), null)
        assert.strictEqual(this, it)
        assert.strictEqual(foo, 'foo')

        return 'test'
      })
      const fn = tracer.wrap('name', {}, callback)

      sinon.spy(tracer, 'trace')

      const result = fn.call(it, 'foo')

      sinon.assert.called(callback)
      sinon.assert.calledWith(tracer.trace, 'name', {})
      assert.strictEqual(result, 'test')
    })

    it('should wait for the callback to be called before finishing the span', done => {
      const fn = tracer.wrap('name', {}, sinon.spy(function (cb) {
        const span = tracer.scope().active()

        sinon.spy(span, 'finish')

        setImmediate(() => {
          sinon.assert.notCalled(span.finish)
        })

        setImmediate(() => cb())

        setImmediate(() => {
          sinon.assert.called(span.finish)
          done()
        })
      }))

      sinon.spy(tracer, 'trace')

      fn(() => {})
    })

    it('should handle rejected promises', done => {
      const fn = tracer.wrap('name', {}, (cb) => cb())
      const catchHandler = sinon.spy(({ message }) => assert.strictEqual(message, 'boom'))

      fn(() => Promise.reject(new Error('boom')))
        .catch(catchHandler)
        .then(() => sinon.assert.called(catchHandler))
        .then(() => done())
    })

    it('should accept an options object', () => {
      const options = { tags: { sometag: 'somevalue' } }

      const fn = tracer.wrap('name', options, function () {})

      sinon.spy(tracer, 'trace')

      fn('hello', 'goodbye')

      sinon.assert.calledWith(tracer.trace, 'name', {
        tags: { sometag: 'somevalue' }
      })
    })

    it('should accept an options function, invoked on every invocation of the wrapped function', () => {
      const it = {}

      let invocations = 0

      function options (foo, bar) {
        invocations++
        assert.strictEqual(this, it)
        assert.strictEqual(foo, 'hello')
        assert.strictEqual(bar, 'goodbye')
        return { tags: { sometag: 'somevalue', invocations } }
      }

      const fn = tracer.wrap('name', options, function () {})

      sinon.spy(tracer, 'trace')

      fn.call(it, 'hello', 'goodbye')

      sinon.assert.calledWith(tracer.trace, 'name', {
        tags: { sometag: 'somevalue', invocations: 1 }
      })

      fn.call(it, 'hello', 'goodbye')

      sinon.assert.calledWith(tracer.trace, 'name', {
        tags: { sometag: 'somevalue', invocations: 2 }
      })
    })
  })
})
