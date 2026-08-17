'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const msgpack = require('@msgpack/msgpack')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const { AgentEncoder } = require('../../src/encode/0.4')
const id = require('../../src/id')

const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'
const firstFlushChannel = channel('dd-trace:exporter:first-flush')

describe('NativeExporter', () => {
  let NativeExporter
  let beforeExitHandlers
  let handlersBefore
  let clock
  let config
  let exporter
  let fetchAgentInfo
  let logDebug
  let logError
  let logWarn
  let metricsIncrement
  let nativeSpans
  let prioritySampler

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    beforeExitHandlers = globalThis[Symbol.for('dd-trace')].beforeExitHandlers
    handlersBefore = new Set(beforeExitHandlers)
    config = {
      url: 'http://localhost:8126',
      flushInterval: 1000,
    }
    prioritySampler = {
      update: sinon.stub(),
    }
    nativeSpans = {
      flushStats: sinon.stub().resolves(true),
      sendEncodedTraces: sinon.stub().resolves('unchanged'),
      setAgentUrl: sinon.stub(),
      setOtlpEndpoint: sinon.stub(),
      setOtlpHeaders: sinon.stub(),
      setOtlpProtocol: sinon.stub(),
      setUseV05: sinon.stub(),
    }
    logDebug = sinon.stub()
    logError = sinon.stub()
    logWarn = sinon.stub()
    metricsIncrement = sinon.stub()
    fetchAgentInfo = sinon.stub()
    NativeExporter = proxyquire('../../src/exporters/native', {
      '../../agent/info': { fetchAgentInfo },
      '../../log': {
        debug: logDebug,
        error: logError,
        warn: logWarn,
      },
      '../../runtime_metrics': { increment: metricsIncrement },
    })
  })

  afterEach(() => {
    for (const handler of beforeExitHandlers) {
      if (!handlersBefore.has(handler)) beforeExitHandlers.delete(handler)
    }
    clock.restore()
  })

  /** @param {number} [testId] */
  function createSpan (testId = 1) {
    return {
      testId,
      trace_id: id('0000000000000001'),
      span_id: id(String(testId).padStart(16, '0')),
      parent_id: id('0000000000000000'),
      name: 'request',
      resource: 'GET /',
      service: 'web',
      meta: {},
      metrics: {},
      error: 0,
      start: 1,
      duration: 2,
    }
  }

  /** @returns {InstanceType<NativeExporter>} */
  function createExporter () {
    exporter = new NativeExporter(config, prioritySampler, nativeSpans)
    return exporter
  }

  /**
   * @param {object[]} [spans]
   * @returns {void}
   */
  function exportChunk (spans = [createSpan()]) {
    exporter.export(spans)
  }

  async function settle () {
    for (let turn = 0; turn < 8; turn++) {
      await Promise.resolve()
    }
  }

  describe('configuration', () => {
    it('enables v0.5 only when the agent advertises it', () => {
      config.protocolVersion = '0.5'
      fetchAgentInfo.callsArgWith(1, undefined, { endpoints: ['/v0.5/traces'] })

      createExporter()

      sinon.assert.calledOnceWithExactly(nativeSpans.setUseV05, true)
    })

    it('ignores malformed v0.5 capability responses', () => {
      config.protocolVersion = '0.5'
      fetchAgentInfo.callsArgWith(1, undefined, { endpoints: '/v0.5/traces' })

      createExporter()

      sinon.assert.notCalled(nativeSpans.setUseV05)
    })

    it('configures OTLP endpoint, protocol, and flattened headers without v0.5 negotiation', () => {
      config.protocolVersion = '0.5'
      config.OTEL_TRACES_EXPORTER = 'otlp'
      config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://collector:4318/v1/traces'
      config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'http/protobuf'
      config.OTEL_EXPORTER_OTLP_TRACES_HEADERS = { authorization: 'token', count: 2 }

      createExporter()

      sinon.assert.calledOnceWithExactly(nativeSpans.setOtlpEndpoint, 'http://collector:4318/v1/traces')
      sinon.assert.calledOnceWithExactly(nativeSpans.setOtlpProtocol, 'http/protobuf')
      sinon.assert.calledOnceWithExactly(nativeSpans.setOtlpHeaders, ['authorization', 'token', 'count', '2'])
      sinon.assert.notCalled(fetchAgentInfo)
    })

    it('warns and keeps the agent route when OTLP has no endpoint', () => {
      config.OTEL_TRACES_EXPORTER = 'otlp'

      createExporter()

      sinon.assert.notCalled(nativeSpans.setOtlpEndpoint)
      sinon.assert.calledOnce(logWarn)
    })

    it('warns and keeps the native default when the OTLP protocol is unsupported', () => {
      config.OTEL_TRACES_EXPORTER = 'otlp'
      config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://collector:4318/v1/traces'
      config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'unsupported'
      nativeSpans.setOtlpProtocol.throws(new Error('unsupported protocol'))

      createExporter()

      sinon.assert.calledOnceWithExactly(nativeSpans.setOtlpEndpoint, 'http://collector:4318/v1/traces')
      sinon.assert.calledOnce(logWarn)
    })

    it('warns and keeps v0.4 when the agent URL cannot be parsed for negotiation', () => {
      config.protocolVersion = '0.5'
      config.url = 'not a URL'

      createExporter()

      sinon.assert.notCalled(fetchAgentInfo)
      sinon.assert.calledOnce(logWarn)
    })

    it('keeps v0.4 when the agent info request fails', () => {
      config.protocolVersion = '0.5'
      fetchAgentInfo.callsArgWith(1, new Error('agent unavailable'))

      createExporter()

      sinon.assert.notCalled(nativeSpans.setUseV05)
      sinon.assert.calledOnce(logDebug)
    })

    it('derives the URL from hostname and port', () => {
      delete config.url
      config.hostname = 'agent.internal'
      config.port = 9126

      createExporter()

      assert.strictEqual(exporter._url.href, 'http://agent.internal:9126/')
    })
  })

  describe('export', () => {
    it('formats BigInt values in lazy debug payloads', () => {
      createExporter()
      const span = createSpan()
      span.meta.value = 1n

      exportChunk([span])

      const message = logDebug.firstCall.args[0]()
      assert.match(message, /"value":"1"/)
    })

    it('encodes finalized data when the batching window ends', () => {
      createExporter()
      const span = createSpan(1)

      exportChunk([span])

      sinon.assert.notCalled(nativeSpans.sendEncodedTraces)
      clock.tick(config.flushInterval)

      sinon.assert.calledOnce(nativeSpans.sendEncodedTraces)
      const decoded = msgpack.decode(nativeSpans.sendEncodedTraces.firstCall.args[0], { useBigInt64: true })
      assert.strictEqual(decoded[0][0].resource, 'GET /')
    })

    it('flushes at the pending span limit', () => {
      createExporter()
      const spans = Array.from({ length: 1999 }, (_, index) => createSpan(index + 1))

      exportChunk(spans)
      sinon.assert.notCalled(nativeSpans.sendEncodedTraces)
      exportChunk([createSpan(2000)])

      sinon.assert.calledOnce(nativeSpans.sendEncodedTraces)
    })

    it('uses native span events for the feature flag and OTLP', () => {
      config.DD_TRACE_NATIVE_SPAN_EVENTS = true
      createExporter()
      const firstSpan = createSpan()
      firstSpan.span_events = [{ name: 'event', startTime: 1.5, attributes: { value: 1 } }]
      exportChunk([firstSpan])
      clock.tick(config.flushInterval)
      const firstPayload = msgpack.decode(nativeSpans.sendEncodedTraces.firstCall.args[0], { useBigInt64: true })
      assert.strictEqual(firstPayload[0][0].span_events[0].name, 'event')

      config.DD_TRACE_NATIVE_SPAN_EVENTS = false
      config.OTEL_TRACES_EXPORTER = 'otlp'
      config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://collector:4318/v1/traces'
      exporter = new NativeExporter(config, prioritySampler, nativeSpans)
      const secondSpan = createSpan()
      secondSpan.span_events = [{ name: 'event', startTime: 2.5 }]
      exportChunk([secondSpan])
      clock.tick(config.flushInterval)
      const secondPayload = msgpack.decode(nativeSpans.sendEncodedTraces.secondCall.args[0], { useBigInt64: true })
      assert.strictEqual(secondPayload[0][0].span_events[0].name, 'event')
    })

    it('handles a synchronous native send error', () => {
      nativeSpans.sendEncodedTraces.throws(new Error('send failed'))
      createExporter()

      exportChunk()
      clock.tick(config.flushInterval)

      sinon.assert.calledOnce(logError)
      sinon.assert.calledOnce(nativeSpans.sendEncodedTraces)
    })

    it('flushes immediately at zero interval', () => {
      config.flushInterval = 0
      createExporter()

      exportChunk()

      sinon.assert.calledOnce(nativeSpans.sendEncodedTraces)
    })

    it('uses one timer for repeated exports and sends all chunks together', () => {
      createExporter()
      exportChunk([createSpan(1)])
      clock.tick(config.flushInterval / 2)
      exportChunk([createSpan(2)])

      clock.tick(config.flushInterval / 2 - 1)
      sinon.assert.notCalled(nativeSpans.sendEncodedTraces)
      clock.tick(1)

      sinon.assert.calledOnce(nativeSpans.sendEncodedTraces)
      const decoded = msgpack.decode(nativeSpans.sendEncodedTraces.firstCall.args[0], { useBigInt64: true })
      assert.strictEqual(decoded.length, 2)
      assert.strictEqual(decoded[0][0].span_id, 1n)
      assert.strictEqual(decoded[1][0].span_id, 2n)
    })
  })

  describe('flush', () => {
    it('settles immediately when there is no pending chunk', () => {
      createExporter()
      const done = sinon.stub()

      exporter.flush(done)

      sinon.assert.calledOnce(done)
      sinon.assert.notCalled(nativeSpans.sendEncodedTraces)
    })

    it('waits for the native send and applies sampling rates', async () => {
      const rates = { 'service:,env:': 0.5 }
      nativeSpans.sendEncodedTraces.resolves(JSON.stringify({ rate_by_service: rates }))
      createExporter()
      exportChunk()
      const done = sinon.stub()

      exporter.flush(done)
      sinon.assert.notCalled(done)
      await settle()

      sinon.assert.calledOnce(done)
      sinon.assert.calledOnceWithExactly(prioritySampler.update, rates)
      sinon.assert.calledWith(metricsIncrement, `${METRIC_PREFIX}.requests`, true)
      sinon.assert.calledWith(metricsIncrement, `${METRIC_PREFIX}.responses`, true)
    })

    it('serializes work queued during an in-flight send', async () => {
      let releaseFirst
      nativeSpans.sendEncodedTraces.onFirstCall().returns(new Promise(resolve => { releaseFirst = resolve }))
      nativeSpans.sendEncodedTraces.onSecondCall().resolves('unchanged')
      createExporter()
      exportChunk([createSpan(1)])
      exporter.flush()
      exportChunk([createSpan(2)])
      const done = sinon.stub()

      exporter.flush(done)
      sinon.assert.calledOnce(nativeSpans.sendEncodedTraces)
      sinon.assert.notCalled(done)
      releaseFirst('unchanged')
      await settle()

      sinon.assert.calledTwice(nativeSpans.sendEncodedTraces)
      sinon.assert.calledOnce(done)
    })

    it('sends one request per chunk at zero interval', async () => {
      config.flushInterval = 0
      createExporter()
      exportChunk([createSpan(1)])
      exportChunk([createSpan(2)])
      await settle()

      sinon.assert.calledTwice(nativeSpans.sendEncodedTraces)
      const firstPayload = msgpack.decode(nativeSpans.sendEncodedTraces.firstCall.args[0], { useBigInt64: true })
      const secondPayload = msgpack.decode(nativeSpans.sendEncodedTraces.secondCall.args[0], { useBigInt64: true })
      assert.strictEqual(firstPayload.length, 1)
      assert.strictEqual(secondPayload.length, 1)
      assert.strictEqual(firstPayload[0][0].span_id, 1n)
      assert.strictEqual(secondPayload[0][0].span_id, 2n)
    })

    it('runs compatibility stats flush after traces finish', async () => {
      let releaseTrace
      nativeSpans.sendEncodedTraces.returns(new Promise(resolve => { releaseTrace = resolve }))
      createExporter()
      exportChunk()
      const done = sinon.stub()

      exporter._writer.flush(done)
      sinon.assert.notCalled(nativeSpans.flushStats)
      releaseTrace('unchanged')
      await settle()

      sinon.assert.calledOnce(nativeSpans.flushStats)
      sinon.assert.calledOnce(done)
    })

    it('completes compatibility flushes when native stats reject', async () => {
      nativeSpans.flushStats.rejects(new Error('stats failed'))
      createExporter()
      const done = sinon.stub()

      exporter._writer.flush(done)
      await settle()

      sinon.assert.calledOnce(done)
      sinon.assert.calledOnce(logError)
    })

    it('logs failed final native stats flushes', async () => {
      nativeSpans.flushStats.rejects(new Error('stats failed'))
      createExporter()
      let finalFlush
      for (const handler of beforeExitHandlers) {
        if (!handlersBefore.has(handler)) finalFlush = handler
      }

      assert.strictEqual(typeof finalFlush, 'function')
      finalFlush()
      await settle()

      sinon.assert.calledOnce(logWarn)
    })

    it('runs every flush callback before surfacing a callback error', async () => {
      let releaseSend
      nativeSpans.sendEncodedTraces.returns(new Promise(resolve => { releaseSend = resolve }))
      createExporter()
      exportChunk()
      const expected = new Error('callback failed')
      const second = sinon.stub()

      exporter.flush(() => { throw expected })
      exporter.flush(second)
      releaseSend('unchanged')
      await settle()

      sinon.assert.calledOnce(second)
      assert.throws(() => clock.runAll(), expected)
    })

    it('handles encoding errors without sending a partial payload', () => {
      createExporter()
      const span = createSpan()
      Object.defineProperty(span, 'meta', {
        get () { throw new Error('invalid meta') },
      })
      const done = sinon.stub()

      exportChunk([span])
      exporter.flush(done)

      sinon.assert.notCalled(nativeSpans.sendEncodedTraces)
      sinon.assert.calledOnce(done)
      sinon.assert.calledOnce(logError)
    })

    it('settles without sending when the encoder drops an oversized trace', () => {
      const encode = sinon.stub(AgentEncoder.prototype, 'encode')
      try {
        createExporter()
        const done = sinon.stub()

        exportChunk()
        exporter.flush(done)

        sinon.assert.notCalled(nativeSpans.sendEncodedTraces)
        sinon.assert.calledOnce(done)
      } finally {
        encode.restore()
      }
    })

    it('ignores malformed native sampling responses', async () => {
      nativeSpans.sendEncodedTraces.resolves('{')
      createExporter()
      exportChunk()

      exporter.flush()
      await settle()

      sinon.assert.notCalled(prioritySampler.update)
      sinon.assert.calledOnce(logError)
    })

    it('retries work queued during a transient failure', async () => {
      let rejectFirst
      nativeSpans.sendEncodedTraces.onFirstCall().returns(new Promise((_resolve, reject) => { rejectFirst = reject }))
      nativeSpans.sendEncodedTraces.onSecondCall().resolves('unchanged')
      createExporter()
      exportChunk([createSpan(1)])
      exporter.flush()
      exportChunk([createSpan(2)])

      rejectFirst(new Error('network failed'))
      await settle()

      sinon.assert.calledOnce(nativeSpans.sendEncodedTraces)
      clock.tick(config.flushInterval)
      await settle()

      sinon.assert.calledTwice(nativeSpans.sendEncodedTraces)
      sinon.assert.called(logError)
    })

    it('disables future exports after a fatal native build failure', async () => {
      const error = new Error('build failed')
      error.name = 'NativeExporterBuildError'
      nativeSpans.sendEncodedTraces.rejects(error)
      createExporter()
      exportChunk([createSpan(1)])
      exporter.flush()
      await settle()
      nativeSpans.sendEncodedTraces.resetHistory()

      exportChunk([createSpan(2)])

      sinon.assert.notCalled(nativeSpans.sendEncodedTraces)
    })

    it('records error name and code on failed sends', async () => {
      const error = new Error('connection refused')
      error.code = 'ECONNREFUSED'
      nativeSpans.sendEncodedTraces.rejects(error)
      createExporter()
      exportChunk()
      exporter.flush()
      await settle()

      sinon.assert.calledWith(metricsIncrement, `${METRIC_PREFIX}.errors`, true)
      sinon.assert.calledWith(metricsIncrement, `${METRIC_PREFIX}.errors.by.name`, 'name:Error', true)
      sinon.assert.calledWith(metricsIncrement, `${METRIC_PREFIX}.errors.by.code`, 'code:ECONNREFUSED', true)
    })
  })

  describe('setUrl', () => {
    it('updates native state immediately while idle', () => {
      createExporter()

      exporter.setUrl('http://agent.internal:9126')

      sinon.assert.calledOnceWithExactly(nativeSpans.setAgentUrl, 'http://agent.internal:9126/')
      assert.strictEqual(exporter._url.href, 'http://agent.internal:9126/')
    })

    it('flushes pending chunks before replacing native state', async () => {
      let releaseSend
      nativeSpans.sendEncodedTraces.returns(new Promise(resolve => { releaseSend = resolve }))
      createExporter()
      exportChunk()

      exporter.setUrl('http://agent.internal:9126')
      sinon.assert.notCalled(nativeSpans.setAgentUrl)
      releaseSend('unchanged')
      await settle()

      sinon.assert.calledOnceWithExactly(nativeSpans.setAgentUrl, 'http://agent.internal:9126/')
    })

    it('waits for an in-flight send before replacing native state', async () => {
      let releaseSend
      nativeSpans.sendEncodedTraces.returns(new Promise(resolve => { releaseSend = resolve }))
      createExporter()
      exportChunk()
      exporter.flush()

      exporter.setUrl('http://agent.internal:9126')
      sinon.assert.notCalled(nativeSpans.setAgentUrl)
      releaseSend('unchanged')
      await settle()

      sinon.assert.calledOnceWithExactly(nativeSpans.setAgentUrl, 'http://agent.internal:9126/')
    })

    it('keeps the old URL when native state replacement fails', () => {
      nativeSpans.setAgentUrl.throws(new Error('invalid native URL'))
      createExporter()

      exporter.setUrl('http://agent.internal:9126')

      assert.strictEqual(exporter._url, 'http://localhost:8126')
      sinon.assert.calledOnce(logWarn)
    })

    it('rejects malformed URLs without touching native state', () => {
      createExporter()

      exporter.setUrl('not a URL')

      sinon.assert.notCalled(nativeSpans.setAgentUrl)
      sinon.assert.calledOnce(logWarn)
    })
  })

  describe('first flush', () => {
    it('publishes exactly once even when the first send rejects', async () => {
      const observer = sinon.stub()
      firstFlushChannel.subscribe(observer)
      nativeSpans.sendEncodedTraces.onFirstCall().rejects(new Error('network failed'))
      nativeSpans.sendEncodedTraces.onSecondCall().resolves('unchanged')
      config.flushInterval = 0
      createExporter()

      exportChunk([createSpan(1)])
      await settle()
      exportChunk([createSpan(2)])
      await settle()

      sinon.assert.calledOnce(observer)
      firstFlushChannel.unsubscribe(observer)
    })
  })
})
