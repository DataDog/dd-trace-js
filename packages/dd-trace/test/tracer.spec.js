'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const { assertObjectContains } = require('../../../integration-tests/helpers')
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

  describe('flushAll', () => {
    it('registers its trace exporter without requiring span statistics', () => {
      const registerFlusher = sinon.spy()

      tracer = new Tracer(config, undefined, registerFlusher)

      sinon.assert.calledWith(registerFlusher, 'traces', sinon.match.func, { trace: true })
      sinon.assert.neverCalledWith(registerFlusher, 'span-stats', sinon.match.func)
    })

    it('does not require lifecycle flushing from the log exporter', () => {
      const registerFlusher = sinon.spy()
      config.experimental.exporter = 'log'

      tracer = new Tracer(config, undefined, registerFlusher)

      sinon.assert.neverCalledWith(registerFlusher, 'traces', sinon.match.func)
    })

    it('registers configured span statistics through the base tracer owner', () => {
      const registerFlusher = sinon.spy()
      config.stats.DD_TRACE_STATS_COMPUTATION_ENABLED = true

      tracer = new Tracer(config, undefined, registerFlusher)

      sinon.assert.calledWith(registerFlusher, 'span-stats', sinon.match.func)
    })

    it('registers lifecycle callbacks supplied by the base tracer owner', () => {
      const traceFlusher = sinon.spy()
      const spanStatsFlusher = sinon.spy()
      const registerFlusher = sinon.spy()
      const OwnedTracer = proxyquire('../src/tracer', {
        './opentracing/tracer': class {
          constructor (tracerConfig, prioritySampler, lifecycleFlushers) {
            lifecycleFlushers.traces = traceFlusher
            lifecycleFlushers.spanStats = spanStatsFlusher
          }
        },
      })

      tracer = new OwnedTracer(config, undefined, registerFlusher)

      sinon.assert.calledWithExactly(registerFlusher, 'traces', traceFlusher, { trace: true })
      sinon.assert.calledWithExactly(registerFlusher, 'span-stats', spanStatsFlusher)
    })

    it('does not register exporters from a partially initialized tracer', () => {
      const constructorError = new Error('scope failed')
      const registerFlusher = sinon.spy()
      const PartialTracer = proxyquire('../src/tracer', {
        './opentracing/tracer': class {
          constructor () {
            this._exporter = { flush () {} }
            this._processor = {}
          }
        },
        './scope': class {
          constructor () { throw constructorError }
        },
      })

      assert.throws(() => new PartialTracer(config, undefined, registerFlusher), constructorError)
      sinon.assert.notCalled(registerFlusher)
    })

    it('replaces a configured pipeline with the same name', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const first = sinon.stub().callsFake(done => done())
      const second = sinon.stub().callsFake(done => done())
      const done = sinon.spy()

      const unregisterFirst = registerFlusher('logs', first)
      registerFlusher('logs', second)
      unregisterFirst()
      flushAll(done)

      sinon.assert.notCalled(first)
      sinon.assert.calledOnce(second)
      sinon.assert.calledOnce(done)
      unregisterFlusher('logs')
    })

    it('flushes registered telemetry pipelines with the configured trace exporter', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const traceFlusher = sinon.stub().callsFake(done => done())
      const telemetryFlusher = sinon.stub().callsFake(done => done())
      let completed = false
      registerFlusher('traces', traceFlusher, { trace: true })
      registerFlusher('telemetry', telemetryFlusher)

      flushAll(() => { completed = true })

      sinon.assert.calledOnce(traceFlusher)
      sinon.assert.calledOnce(telemetryFlusher)
      assert.strictEqual(completed, true)
      unregisterFlusher('traces')
      unregisterFlusher('telemetry')
    })

    it('flushes post-trace telemetry after the trace exporter completes', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      let traceDone
      const traceFlusher = sinon.stub().callsFake(done => { traceDone = done })
      const runtimeMetricsFlusher = sinon.stub().callsFake(done => done())
      const done = sinon.spy()
      registerFlusher('traces', traceFlusher, { trace: true })
      registerFlusher('runtime-metrics', runtimeMetricsFlusher, { afterTrace: true })

      flushAll(done)

      sinon.assert.notCalled(runtimeMetricsFlusher)
      traceDone()
      sinon.assert.calledOnce(runtimeMetricsFlusher)
      sinon.assert.calledOnce(done)
      unregisterFlusher('traces')
      unregisterFlusher('runtime-metrics')
    })

    it('flushes post-trace telemetry immediately without a trace exporter', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const runtimeMetricsFlusher = sinon.stub().callsFake(done => done())
      const done = sinon.spy()
      registerFlusher('runtime-metrics', runtimeMetricsFlusher, { afterTrace: true })

      try {
        flushAll(done)

        sinon.assert.calledOnce(runtimeMetricsFlusher)
        sinon.assert.calledOnce(done)
      } finally {
        unregisterFlusher('runtime-metrics')
      }
    })

    it('flushes registered telemetry pipelines without a trace exporter', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const telemetryFlusher = sinon.stub().callsFake(done => done())
      const done = sinon.spy()
      registerFlusher('telemetry', telemetryFlusher)

      flushAll(done)

      sinon.assert.calledOnce(telemetryFlusher)
      sinon.assert.calledOnce(done)
      unregisterFlusher('telemetry')
    })

    it('waits for callback flushers that return a synchronous status', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      let flushDone
      const telemetryFlusher = sinon.stub().callsFake(done => {
        flushDone = done
        return false
      })
      const done = sinon.spy()
      registerFlusher('telemetry', telemetryFlusher)

      try {
        flushAll(done)

        sinon.assert.notCalled(done)
        flushDone()
        sinon.assert.calledOnce(done)
      } finally {
        unregisterFlusher('telemetry')
      }
    })

    it('waits for promise flushers', async () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      let resolveFlusher
      const flusherPromise = new Promise(resolve => { resolveFlusher = resolve })
      registerFlusher('telemetry', () => flusherPromise)
      let completed = false
      const flushed = new Promise(resolve => {
        flushAll(() => {
          completed = true
          resolve()
        })
      })

      try {
        assert.strictEqual(completed, false)
        resolveFlusher()
        await flushed
        assert.strictEqual(completed, true)
      } finally {
        unregisterFlusher('telemetry')
      }
    })

    it('logs a failure reported through the flusher callback', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const log = require('../src/log')
      const errorLog = sinon.stub(log, 'error')
      const flushError = new Error('flush failed')
      const done = sinon.spy()
      registerFlusher('telemetry', flushDone => flushDone(flushError))

      try {
        flushAll(done)

        sinon.assert.calledOnceWithExactly(errorLog, 'Error flushing telemetry pipeline: %s', flushError)
        sinon.assert.calledOnce(done)
      } finally {
        unregisterFlusher('telemetry')
        errorLog.restore()
      }
    })

    it('ignores a promise rejection after its flusher callback completes', async () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const log = require('../src/log')
      const errorLog = sinon.stub(log, 'error')
      const flushError = new Error('late failure')
      const done = sinon.spy()
      registerFlusher('telemetry', flushDone => {
        flushDone()
        return Promise.reject(flushError)
      })

      try {
        flushAll(done)
        await new Promise(resolve => setImmediate(resolve))

        sinon.assert.notCalled(errorLog)
        sinon.assert.calledOnce(done)
      } finally {
        unregisterFlusher('telemetry')
        errorLog.restore()
      }
    })

    it('completes once when a flusher invokes its callback more than once', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const done = sinon.spy()
      registerFlusher('telemetry', flushDone => {
        flushDone()
        flushDone()
      })

      try {
        flushAll(done)

        sinon.assert.calledOnce(done)
      } finally {
        unregisterFlusher('telemetry')
      }
    })

    it('logs an error thrown after a flusher completes without completing twice', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const log = require('../src/log')
      const errorLog = sinon.stub(log, 'error')
      const flushError = new Error('post-completion failure')
      const done = sinon.spy()
      registerFlusher('telemetry', flushDone => {
        flushDone()
        throw flushError
      })

      try {
        flushAll(done)

        sinon.assert.calledOnceWithExactly(errorLog, 'Error flushing telemetry pipeline: %s', flushError)
        sinon.assert.calledOnce(done)
      } finally {
        unregisterFlusher('telemetry')
        errorLog.restore()
      }
    })

    it('logs a falsy value thrown by a flusher', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const log = require('../src/log')
      const errorLog = sinon.stub(log, 'error')
      const flushError = null
      const done = sinon.spy()
      registerFlusher('telemetry', () => { throw flushError })

      try {
        flushAll(done)

        sinon.assert.calledOnceWithExactly(errorLog, 'Error flushing telemetry pipeline: %s', flushError)
        sinon.assert.calledOnce(done)
      } finally {
        unregisterFlusher('telemetry')
        errorLog.restore()
      }
    })

    it('continues flushing sibling pipelines when one flusher throws', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const flushError = new Error('logs failed')
      const metricsFlusher = sinon.stub().callsFake(done => done())
      const done = sinon.spy()
      registerFlusher('logs', () => { throw flushError })
      registerFlusher('metrics', metricsFlusher)

      try {
        flushAll(done)

        sinon.assert.calledOnce(metricsFlusher)
        sinon.assert.calledOnce(done)
      } finally {
        unregisterFlusher('logs')
        unregisterFlusher('metrics')
      }
    })

    it('logs a falsy value rejected by a promise flusher', async () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const log = require('../src/log')
      const errorLog = sinon.stub(log, 'error')
      const flushError = null
      registerFlusher('telemetry', () => Promise.reject(flushError))

      try {
        await new Promise(resolve => flushAll(resolve))

        sinon.assert.calledOnceWithExactly(errorLog, 'Error flushing telemetry pipeline: %s', flushError)
      } finally {
        unregisterFlusher('telemetry')
        errorLog.restore()
      }
    })

    it('bounds configured telemetry flushing', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const timeout = sinon.stub(global, 'setTimeout')
      const clearTimeout = sinon.stub(global, 'clearTimeout')
      const cancel = sinon.spy()
      const done = sinon.spy()
      registerFlusher('telemetry', () => cancel)

      try {
        flushAll(done, { timeout: 2_000 })

        sinon.assert.calledWith(timeout, sinon.match.func, 2_000)
        timeout.firstCall.args[0]()
        sinon.assert.calledOnce(done)
        sinon.assert.calledOnce(cancel)
        sinon.assert.called(clearTimeout)
      } finally {
        unregisterFlusher('telemetry')
        timeout.restore()
        clearTimeout.restore()
      }
    })

    it('continues cancelling telemetry flushes when one cancellation throws', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const timeout = sinon.stub(global, 'setTimeout')
      const clearTimeout = sinon.stub(global, 'clearTimeout')
      const failedCancel = sinon.stub().throws(new Error('cancel failed'))
      const successfulCancel = sinon.spy()
      const done = sinon.spy()
      registerFlusher('logs', () => failedCancel)
      registerFlusher('metrics', () => successfulCancel)

      try {
        flushAll(done, { timeout: 2_000 })
        timeout.firstCall.args[0]()

        sinon.assert.calledOnce(failedCancel)
        sinon.assert.calledOnce(successfulCancel)
        sinon.assert.calledOnce(done)
      } finally {
        unregisterFlusher('logs')
        unregisterFlusher('metrics')
        timeout.restore()
        clearTimeout.restore()
      }
    })

    it('cancels only telemetry flushes still pending at the timeout', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const timeout = sinon.stub(global, 'setTimeout')
      const clearTimeout = sinon.stub(global, 'clearTimeout')
      const completedCancel = sinon.spy()
      const pendingCancel = sinon.spy()
      let completeLogs
      registerFlusher('logs', done => {
        completeLogs = done
        return completedCancel
      })
      registerFlusher('metrics', () => pendingCancel)

      try {
        flushAll(sinon.spy(), { timeout: 2_000 })
        completeLogs()
        timeout.firstCall.args[0]()

        sinon.assert.notCalled(completedCancel)
        sinon.assert.calledOnce(pendingCancel)
      } finally {
        unregisterFlusher('logs')
        unregisterFlusher('metrics')
        timeout.restore()
        clearTimeout.restore()
      }
    })

    it('does not start post-trace telemetry after the flush times out', () => {
      const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
      const timeout = sinon.stub(global, 'setTimeout')
      const clearTimeout = sinon.stub(global, 'clearTimeout')
      let traceDone
      const traceFlusher = sinon.stub().callsFake(done => { traceDone = done })
      const runtimeMetricsFlusher = sinon.spy()
      registerFlusher('traces', traceFlusher, { trace: true })
      registerFlusher('runtime-metrics', runtimeMetricsFlusher, { afterTrace: true })

      try {
        flushAll(sinon.spy(), { timeout: 2_000 })
        timeout.firstCall.args[0]()
        traceDone()

        sinon.assert.notCalled(runtimeMetricsFlusher)
      } finally {
        unregisterFlusher('traces')
        unregisterFlusher('runtime-metrics')
        timeout.restore()
        clearTimeout.restore()
      }
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
          foo: 'bar',
        },
      }

      tracer.trace('name', options, span => {
        assert.ok(span instanceof Span)
        assertObjectContains(span.context().getTags(), options.tags)
        assertObjectContains(span.context().getTags(), {
          [SERVICE_NAME]: 'service',
          [RESOURCE_NAME]: 'resource',
          [SPAN_TYPE]: 'type',
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
          tags = span.context().getTags()
          sinon.spy(span, 'finish')
          throw new Error('boom')
        })
      } catch (e) {
        sinon.assert.called(span.finish)
        assertObjectContains(tags, {
          [ERROR_TYPE]: e.name,
          [ERROR_MESSAGE]: e.message,
          [ERROR_STACK]: e.stack,
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
          tags = span.context().getTags()
          sinon.spy(span, 'finish')
          done = _done
        })

        done(error)

        sinon.assert.called(span.finish)
        assertObjectContains(tags, {
          [ERROR_TYPE]: error.name,
          [ERROR_MESSAGE]: error.message,
          [ERROR_STACK]: error.stack,
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
            tags = span.context().getTags()
            sinon.spy(span, 'finish')
            return Promise.reject(new Error('boom'))
          })
          .catch(e => {
            sinon.assert.called(span.finish)
            assertObjectContains(tags, {
              [ERROR_TYPE]: e.name,
              [ERROR_MESSAGE]: e.message,
              [ERROR_STACK]: e.stack,
            })
            done()
          })
          .catch(done)
      })

      it('should not treat rejections as handled', done => {
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
        const re = /<meta name="dd-trace-id" content="(\w+)" \/><meta name="dd-trace-time" content="(\d+)" \/>/
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
        tags: { sometag: 'somevalue' },
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
        tags: { sometag: 'somevalue', invocations: 1 },
      })

      fn.call(it, 'hello', 'goodbye')

      sinon.assert.calledWith(tracer.trace, 'name', {
        tags: { sometag: 'somevalue', invocations: 2 },
      })
    })
  })

  describe('service discovery warning', () => {
    const WARNING = 'Could not store tracer configuration for service discovery'
    const log = require('../src/log')
    let warnSpy
    let originalLogLevel
    let originalDebug

    beforeEach(() => {
      warnSpy = sinon.spy(console, 'warn')
      originalLogLevel = process.env.DD_TRACE_LOG_LEVEL
      originalDebug = process.env.DD_TRACE_DEBUG
      process.env.DD_TRACE_DEBUG = 'true'
    })

    afterEach(() => {
      warnSpy.restore()
      if (originalLogLevel === undefined) delete process.env.DD_TRACE_LOG_LEVEL
      else process.env.DD_TRACE_LOG_LEVEL = originalLogLevel
      if (originalDebug === undefined) delete process.env.DD_TRACE_DEBUG
      else process.env.DD_TRACE_DEBUG = originalDebug
      log.configure({})
    })

    function countWarningsAtLevel (level) {
      process.env.DD_TRACE_LOG_LEVEL = level
      log.configure({})
      const PatchedTracer = proxyquire('../src/tracer', {
        './tracer_metadata': () => undefined,
      })
      // eslint-disable-next-line no-new
      new PatchedTracer(getConfig({ service: 'service' }))
      return warnSpy.getCalls().filter(c => c.firstArg.includes(WARNING)).length
    }

    it('should not log the service discovery warning when log level is error', () => {
      assert.strictEqual(countWarningsAtLevel('error'), 0,
        'expected service discovery warning to be suppressed at log level error')
    })

    it('should log the service discovery warning when log level allows warnings', () => {
      assert.ok(countWarningsAtLevel('warn') >= 1,
        'expected service discovery warning to be emitted at log level warn')
    })
  })
})
