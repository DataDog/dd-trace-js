'use strict'

const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const http = require('node:http')

const { after, before, describe, it } = require('mocha')
const sinon = require('sinon')
const { trace } = require('@opentelemetry/api')

require('../setup/core')
const TracerProvider = require('../../src/opentelemetry/tracer_provider')
const Tracer = require('../../src/opentelemetry/tracer')
const { MultiSpanProcessor, NoopSpanProcessor } = require('../../src/opentelemetry/span_processor')

const agentResponse = JSON.stringify({ rate_by_service: {} })

let traceRequestCount = 0
let traceRequestEvents
let traceRequestResolve

/**
 * @param {(response: import('node:http').ServerResponse) => void} resolve
 */
function captureTraceRequest (resolve) {
  traceRequestResolve = resolve
}

/**
 * @param {string[]} [events]
 * @returns {Promise<import('node:http').ServerResponse>}
 */
function waitForTraceRequest (events) {
  traceRequestEvents = events
  return new Promise(captureTraceRequest)
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
function handleAgentRequest (request, response) {
  request.resume()

  if (!request.url?.endsWith('/traces')) {
    response.end('{}')
    return
  }

  traceRequestCount++
  if (!traceRequestResolve) {
    response.end(agentResponse)
    return
  }

  const resolve = traceRequestResolve
  traceRequestResolve = undefined
  traceRequestEvents?.push('agent-received')
  traceRequestEvents = undefined
  resolve(response)
}

/**
 * @param {Error & { status?: number }} error
 * @returns {boolean}
 */
function isAgentFailure (error) {
  assert.strictEqual(error.status, 500)
  return true
}

describe('OTel TracerProvider', () => {
  it('should register with OTel API', () => {
    const provider = new TracerProvider()
    provider.register()

    assert.strictEqual(trace.getTracerProvider().getDelegate(), provider)
  })

  it('should get tracer', () => {
    const provider = new TracerProvider()
    const tracer = provider.getTracer()

    assert.ok(tracer instanceof Tracer)
    assert.strictEqual(tracer, provider.getTracer())
  })

  it('should get unique tracers by name and version key', () => {
    const provider = new TracerProvider()
    const tracer = provider.getTracer('a', '1')

    assert.strictEqual(tracer, provider.getTracer('a', '1'))
    assert.notStrictEqual(tracer, provider.getTracer('a', '2'))
    assert.notStrictEqual(tracer, provider.getTracer('b', '1'))
  })

  it('should get active span processor', () => {
    const provider = new TracerProvider()

    // Initially is a NoopSpanProcessor
    assert.ok(provider.getActiveSpanProcessor() instanceof NoopSpanProcessor)

    // Swap out shutdown function to check if it's called
    const shutdown = sinon.stub()
    provider.getActiveSpanProcessor().shutdown = shutdown

    // After adding a span processor it should be a MultiSpanProcessor
    provider.addSpanProcessor(new NoopSpanProcessor())
    sinon.assert.calledOnce(shutdown)
    assert.ok(provider.getActiveSpanProcessor() instanceof MultiSpanProcessor)
  })

  it('should wire span processors passed through the constructor', () => {
    // @opentelemetry/sdk-node 0.220+ builds the provider from
    // @opentelemetry/sdk-trace 2.x, which hands processors to the constructor
    // instead of `addSpanProcessor`. A processor supplied that way has to reach
    // the active fan-out so a user's exporter still sees onStart/onEnd.
    const first = new NoopSpanProcessor()
    const second = new NoopSpanProcessor()
    first.onStart = sinon.stub()
    first.onEnd = sinon.stub()
    second.onStart = sinon.stub()
    second.onEnd = sinon.stub()

    const provider = new TracerProvider({ spanProcessors: [first, second] })

    const active = provider.getActiveSpanProcessor()
    assert.ok(active instanceof MultiSpanProcessor)

    const span = {}
    const context = {}
    active.onStart(span, context)
    active.onEnd(span)

    sinon.assert.calledOnceWithExactly(first.onStart, span, context)
    sinon.assert.calledOnceWithExactly(first.onEnd, span)
    sinon.assert.calledOnceWithExactly(second.onStart, span, context)
    sinon.assert.calledOnceWithExactly(second.onEnd, span)
  })

  it('should not register a constructor span processor twice', () => {
    const processor = new NoopSpanProcessor()
    processor.onStart = sinon.stub()
    processor.onEnd = sinon.stub()

    const provider = new TracerProvider({ spanProcessors: [processor] })
    provider.addSpanProcessor(processor)

    const span = {}
    const context = {}
    provider.getActiveSpanProcessor().onStart(span, context)
    provider.getActiveSpanProcessor().onEnd(span)

    sinon.assert.calledOnceWithExactly(processor.onStart, span, context)
    sinon.assert.calledOnceWithExactly(processor.onEnd, span)
  })

  it('should keep the noop processor when the constructor gets no processors', () => {
    assert.ok(new TracerProvider().getActiveSpanProcessor() instanceof NoopSpanProcessor)
    assert.ok(new TracerProvider({ spanProcessors: [] }).getActiveSpanProcessor() instanceof NoopSpanProcessor)
  })

  it('should delegate shutdown to active span processor', () => {
    const provider = new TracerProvider()
    const processor = new NoopSpanProcessor()
    provider.addSpanProcessor(processor)
    processor.shutdown = sinon.stub()

    provider.shutdown()
    sinon.assert.calledOnce(processor.shutdown)
  })

  describe('forceFlush without an initialized tracer', () => {
    it('rejects', async () => {
      const provider = new TracerProvider()

      await assert.rejects(provider.forceFlush(), { message: 'Not started' })
    })
  })

  describe('forceFlush with an initialized tracer', () => {
    let agent
    let originalRemoteConfigEnabled

    before(async () => {
      originalRemoteConfigEnabled = process.env.DD_REMOTE_CONFIGURATION_ENABLED
      process.env.DD_REMOTE_CONFIGURATION_ENABLED = 'false'

      agent = http.createServer(handleAgentRequest)
      agent.listen(0, '127.0.0.1')
      await once(agent, 'listening')

      const { port } = agent.address()
      require('../../index').init({
        flushInterval: 0,
        plugins: false,
        startupLogs: false,
        url: `http://127.0.0.1:${port}`,
      })
    })

    after(async () => {
      if (originalRemoteConfigEnabled === undefined) {
        delete process.env.DD_REMOTE_CONFIGURATION_ENABLED
      } else {
        process.env.DD_REMOTE_CONFIGURATION_ENABLED = originalRemoteConfigEnabled
      }

      const closed = once(agent, 'close')
      agent.close()
      agent.closeAllConnections?.()
      await closed
    })

    it('waits for Datadog delivery to complete', async () => {
      const events = []
      const requestReceived = waitForTraceRequest(events)
      const provider = new TracerProvider()
      provider.getTracer().startSpan('otel.force_flush.delayed').end()

      const forceFlush = provider.forceFlush().then(() => events.push('forceFlush-resolved'))
      const response = await requestReceived

      assert.deepStrictEqual(events, ['agent-received'])

      const responseFinished = once(response, 'finish')
      response.end(agentResponse)
      await responseFinished
      events.push('agent-responded')
      await forceFlush

      assert.deepStrictEqual(events, ['agent-received', 'agent-responded', 'forceFlush-resolved'])
    })

    it('starts every overlapping flush boundary immediately', async () => {
      const firstSignal = new EventEmitter()
      const secondSignal = new EventEmitter()
      const processor = new NoopSpanProcessor()
      processor.forceFlush = sinon.stub()
      processor.forceFlush.onFirstCall().returns(once(firstSignal, 'done'))
      processor.forceFlush.onSecondCall().returns(once(secondSignal, 'done'))
      const provider = new TracerProvider({ spanProcessors: [processor] })

      const firstFlush = provider.forceFlush()
      const secondFlush = provider.forceFlush()

      sinon.assert.calledTwice(processor.forceFlush)
      firstSignal.emit('done')
      secondSignal.emit('done')
      await Promise.all([firstFlush, secondFlush])
    })

    it('reports a delivery failure to every overlapping flush boundary', async () => {
      const provider = new TracerProvider()
      const requestReceived = waitForTraceRequest()
      provider.getTracer().startSpan('otel.force_flush.overlapping_failure').end()

      const firstFlush = provider.forceFlush()
      const response = await requestReceived
      const secondFlush = provider.forceFlush()
      const firstRejected = assert.rejects(firstFlush, isAgentFailure)
      const secondRejected = assert.rejects(secondFlush, isAgentFailure)

      response.statusCode = 500
      response.end('agent failed')

      await Promise.all([firstRejected, secondRejected])
    })

    it('resolves without sending when the Datadog buffer is empty', async () => {
      const requestsBeforeFlush = traceRequestCount

      await new TracerProvider().forceFlush()

      assert.strictEqual(traceRequestCount, requestsBeforeFlush)
    })

    it('waits for every configured span processor', async () => {
      const firstSignal = new EventEmitter()
      const secondSignal = new EventEmitter()
      const firstDone = once(firstSignal, 'done')
      const secondDone = once(secondSignal, 'done')
      const first = new NoopSpanProcessor()
      const second = new NoopSpanProcessor()
      first.forceFlush = sinon.stub().returns(firstDone)
      second.forceFlush = sinon.stub().returns(secondDone)
      const provider = new TracerProvider({ spanProcessors: [first, second] })
      let settled = false

      const forceFlush = provider.forceFlush().finally(() => { settled = true })

      sinon.assert.calledOnce(first.forceFlush)
      sinon.assert.calledOnce(second.forceFlush)
      firstSignal.emit('done')
      await firstDone
      assert.strictEqual(settled, false)
      secondSignal.emit('done')
      await forceFlush
      assert.strictEqual(settled, true)
    })

    it('flushes every processor when one throws synchronously', async () => {
      const error = new Error('processor failed')
      const first = new NoopSpanProcessor()
      const second = new NoopSpanProcessor()
      first.forceFlush = sinon.stub().throws(error)
      second.forceFlush = sinon.stub().resolves()
      const provider = new TracerProvider({ spanProcessors: [first, second] })

      const forceFlush = provider.forceFlush()

      sinon.assert.calledOnce(first.forceFlush)
      sinon.assert.calledOnce(second.forceFlush)
      await assert.rejects(forceFlush, error)
    })

    it('waits for delivery after a span processor fails, then rejects with the original error', async () => {
      const processorError = new Error('processor failed')
      const processor = new NoopSpanProcessor()
      processor.forceFlush = sinon.stub().rejects(processorError)
      const provider = new TracerProvider({ spanProcessors: [processor] })
      const requestReceived = waitForTraceRequest()
      provider.getTracer().startSpan('otel.force_flush.processor_error').end()
      let settled = false

      const forceFlush = provider.forceFlush().finally(() => { settled = true })
      await assert.rejects(processor.forceFlush.firstCall.returnValue, processorError)
      assert.strictEqual(settled, false)

      const response = await requestReceived
      response.end(agentResponse)

      await assert.rejects(forceFlush, error => {
        assert.strictEqual(error, processorError)
        return true
      })
      assert.strictEqual(settled, true)
    })

    it('aggregates multiple span processor failures', async () => {
      const firstError = new Error('first processor failed')
      const secondError = new Error('second processor failed')
      const first = new NoopSpanProcessor()
      const second = new NoopSpanProcessor()
      first.forceFlush = sinon.stub().rejects(firstError)
      second.forceFlush = sinon.stub().rejects(secondError)
      const provider = new TracerProvider({ spanProcessors: [first, second] })

      await assert.rejects(provider.forceFlush(), error => {
        assert.ok(error instanceof AggregateError)
        assert.deepStrictEqual(error.errors, [firstError, secondError])
        return true
      })
    })

    it('preserves a single aggregate span processor failure', async () => {
      const processorError = new AggregateError([new Error('processor failed')], 'processor aggregate')
      const processor = new NoopSpanProcessor()
      processor.forceFlush = sinon.stub().rejects(processorError)
      const provider = new TracerProvider({ spanProcessors: [processor] })

      await assert.rejects(provider.forceFlush(), error => {
        assert.strictEqual(error, processorError)
        return true
      })
    })

    it('rejects when Datadog delivery fails', async () => {
      const requestReceived = waitForTraceRequest()
      const provider = new TracerProvider()
      provider.getTracer().startSpan('otel.force_flush.exporter_error').end()

      const forceFlush = provider.forceFlush()
      const response = await requestReceived
      response.statusCode = 500
      response.end('agent failed')

      await assert.rejects(forceFlush, isAgentFailure)
    })

    it('delegates to the active span processor', async () => {
      const provider = new TracerProvider()
      const processor = new NoopSpanProcessor()
      provider.addSpanProcessor(processor)
      processor.forceFlush = sinon.stub().resolves()

      await provider.forceFlush()

      sinon.assert.calledOnce(processor.forceFlush)
    })

    it('prefers an exporter-specific force flush boundary', async () => {
      const datadogTracer = require('../../index')._tracer
      const originalExporter = datadogTracer._exporter
      const flush = sinon.stub()
      const forceFlush = sinon.stub().callsArg(0)
      datadogTracer._exporter = { export: sinon.stub(), flush, forceFlush }

      try {
        await new TracerProvider().forceFlush()
      } finally {
        datadogTracer._exporter = originalExporter
      }

      sinon.assert.calledOnce(forceFlush)
      sinon.assert.notCalled(flush)
    })

    it('still flushes processors when the exporter has no flush method', async () => {
      const datadogTracer = require('../../index')._tracer
      const originalExporter = datadogTracer._exporter
      datadogTracer._exporter = { export: sinon.stub() }
      const processor = new NoopSpanProcessor()
      processor.forceFlush = sinon.stub().resolves()
      const provider = new TracerProvider({ spanProcessors: [processor] })

      try {
        await provider.forceFlush()
      } finally {
        datadogTracer._exporter = originalExporter
      }

      sinon.assert.calledOnce(processor.forceFlush)
    })
  })
})
