'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

function createTrace () {
  return { tags: {}, started: [] }
}

function createMockSpan (id, trace = createTrace(), options = {}) {
  const tags = { ...options.tags }
  const context = {
    _nativeSpanId: Uint8Array.of(id),
    _parentId: options.parentId ?? null,
    _isRemote: options.isRemote ?? false,
    _name: `span-${id}`,
    _trace: trace,
    getTag: key => tags[key],
    getTags: () => tags,
    hasTag: key => Object.hasOwn(tags, key),
    setTag: (key, value) => { tags[key] = value },
  }
  const span = { context: () => context }
  trace.started.push(span)
  return span
}

describe('NativeExporter', () => {
  let NativeExporter
  let config
  let prioritySampler
  let nativeSpans
  let fetchAgentInfo
  let log
  let runtimeMetrics
  let startupLog
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    config = { url: 'http://localhost:8126', flushInterval: 1000 }
    prioritySampler = { update: sinon.stub() }
    nativeSpans = {
      discardSpansGrouped: sinon.stub().returns(1),
      flushSpansGrouped: sinon.stub().callsFake((_groups, done) => done(undefined, 'unchanged')),
      setAgentUrl: sinon.stub(),
      setOtlpEndpoint: sinon.stub(),
      setOtlpHeaders: sinon.stub(),
      setOtlpProtocol: sinon.stub(),
      setUseV05: sinon.stub(),
    }
    fetchAgentInfo = sinon.stub()
    log = {
      debug: sinon.stub(),
      error: sinon.stub(),
      errorWithoutTelemetry: sinon.stub(),
      warn: sinon.stub(),
    }
    runtimeMetrics = { increment: sinon.stub() }
    startupLog = { logAgentError: sinon.stub(), logIntegrations: sinon.stub() }

    NativeExporter = proxyquire('../../src/exporters/native', {
      '../../agent/info': { fetchAgentInfo },
      '../../log': log,
      '../../runtime_metrics': runtimeMetrics,
      '../../startup-log': startupLog,
    })
  })

  afterEach(() => {
    clock.restore()
  })

  it('negotiates v0.5 only when the agent advertises it', () => {
    config.protocolVersion = '0.5'
    fetchAgentInfo.callsArgWith(1, undefined, { endpoints: ['/v0.4/traces', '/v0.5/traces'] })

    // eslint-disable-next-line no-new
    new NativeExporter(config, prioritySampler, nativeSpans)

    sinon.assert.calledOnceWithExactly(nativeSpans.setUseV05, true)
  })

  it('stays on v0.4 for malformed agent info', () => {
    config.protocolVersion = '0.5'
    fetchAgentInfo.callsArgWith(1, undefined, { endpoints: '/v0.5/traces' })

    // eslint-disable-next-line no-new
    new NativeExporter(config, prioritySampler, nativeSpans)

    sinon.assert.notCalled(nativeSpans.setUseV05)
  })

  it('forwards OTLP endpoint, protocol, and headers without v0.5 negotiation', () => {
    Object.assign(config, {
      protocolVersion: '0.5',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces',
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: { authorization: 'Bearer token', tenant: 7 },
    })

    // eslint-disable-next-line no-new
    new NativeExporter(config, prioritySampler, nativeSpans)

    sinon.assert.calledOnceWithExactly(nativeSpans.setOtlpEndpoint, 'http://collector:4318/v1/traces')
    sinon.assert.calledOnceWithExactly(nativeSpans.setOtlpProtocol, 'http/protobuf')
    sinon.assert.calledOnceWithExactly(
      nativeSpans.setOtlpHeaders,
      ['authorization', 'Bearer token', 'tenant', '7']
    )
    sinon.assert.notCalled(fetchAgentInfo)
  })

  it('falls back to the native OTLP default for an unsupported protocol', () => {
    config.OTEL_TRACES_EXPORTER = 'otlp'
    config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://collector:4318/v1/traces'
    config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = 'grpc'
    nativeSpans.setOtlpProtocol.throws(new Error('unsupported'))

    // eslint-disable-next-line no-new
    new NativeExporter(config, prioritySampler, nativeSpans)

    sinon.assert.calledOnce(log.warn)
  })

  it('buffers spans until the flush interval and sends trace groups', () => {
    const exporter = new NativeExporter(config, prioritySampler, nativeSpans)
    const trace = createTrace()
    const root = createMockSpan(1, trace)
    const child = createMockSpan(2, trace, { parentId: Uint8Array.of(1) })

    exporter.export([root, child])
    sinon.assert.notCalled(nativeSpans.flushSpansGrouped)

    clock.tick(config.flushInterval)

    sinon.assert.calledOnce(nativeSpans.flushSpansGrouped)
    const groups = nativeSpans.flushSpansGrouped.firstCall.args[0]
    assert.strictEqual(groups.length, 1)
    assert.deepStrictEqual(groups[0].spanIds, [root.context()._nativeSpanId, child.context()._nativeSpanId])
    assert.strictEqual(groups[0].firstIsLocalRoot, true)
  })

  it('preserves remote-parent local-root provenance', () => {
    const exporter = new NativeExporter(config, prioritySampler, nativeSpans)
    const trace = createTrace()
    const localRoot = createMockSpan(1, trace, { parentId: Uint8Array.of(9), isRemote: true })

    exporter.export([localRoot])
    exporter.flush()

    const [group] = nativeSpans.flushSpansGrouped.firstCall.args[0]
    assert.strictEqual(group.firstIsLocalRoot, true)
  })

  it('marks partial chunks as lacking a local root and mirrors trace tags to their head', () => {
    const exporter = new NativeExporter(config, prioritySampler, nativeSpans)
    const trace = createTrace()
    createMockSpan(1, trace)
    const child = createMockSpan(2, trace, { parentId: Uint8Array.of(1) })
    trace.tags['_dd.p.dm'] = '-1'

    exporter.export([child])
    exporter.flush()

    const [group] = nativeSpans.flushSpansGrouped.firstCall.args[0]
    assert.strictEqual(group.firstIsLocalRoot, false)
    assert.strictEqual(child.context().getTag('_dd.p.dm'), '-1')
  })

  it('sends one trace group per request when flushInterval is zero', () => {
    config.flushInterval = 0
    const exporter = new NativeExporter(config, prioritySampler, nativeSpans)

    exporter.export([createMockSpan(1), createMockSpan(2)])

    sinon.assert.calledTwice(nativeSpans.flushSpansGrouped)
    assert.strictEqual(nativeSpans.flushSpansGrouped.firstCall.args[0].length, 1)
    assert.strictEqual(nativeSpans.flushSpansGrouped.secondCall.args[0].length, 1)
  })

  it('waits for an in-flight send before completing an explicit flush', () => {
    let finishSend
    nativeSpans.flushSpansGrouped.callsFake((_groups, done) => { finishSend = done })
    const exporter = new NativeExporter(config, prioritySampler, nativeSpans)
    const done = sinon.stub()

    exporter.export([createMockSpan(1)])
    exporter.flush()
    exporter.flush(done)

    sinon.assert.notCalled(done)
    finishSend(undefined, 'unchanged')
    sinon.assert.calledOnce(done)
  })

  it('updates priority sampling rates and exporter health on a response', () => {
    const rates = { 'service:,env:': 0.5 }
    nativeSpans.flushSpansGrouped.callsFake((_groups, done) => {
      done(undefined, JSON.stringify({ rate_by_service: rates }))
    })
    const exporter = new NativeExporter(config, prioritySampler, nativeSpans)

    exporter.export([createMockSpan(1)])
    exporter.flush()

    sinon.assert.calledOnceWithExactly(prioritySampler.update, rates)
    sinon.assert.calledOnce(startupLog.logIntegrations)
    assert(runtimeMetrics.increment.calledWith('datadog.tracer.node.exporter.agent.requests', true))
    assert(runtimeMetrics.increment.calledWith('datadog.tracer.node.exporter.agent.responses', true))
  })

  it('reports malformed sampling responses without breaking the queue', () => {
    nativeSpans.flushSpansGrouped.callsFake((_groups, done) => done(undefined, '{'))
    const exporter = new NativeExporter(config, prioritySampler, nativeSpans)

    exporter.export([createMockSpan(1)])
    exporter.flush()

    sinon.assert.calledOnce(log.error)
  })

  it('reports transport errors and continues with the next queued batch', () => {
    config.flushInterval = 0
    nativeSpans.flushSpansGrouped
      .onFirstCall().callsFake((_groups, done) => done(new Error('network')))
      .onSecondCall().callsFake((_groups, done) => done(undefined, 'unchanged'))
    const exporter = new NativeExporter(config, prioritySampler, nativeSpans)

    exporter.export([createMockSpan(1), createMockSpan(2)])

    sinon.assert.calledTwice(nativeSpans.flushSpansGrouped)
    sinon.assert.calledOnce(startupLog.logAgentError)
    sinon.assert.calledOnce(log.errorWithoutTelemetry)
  })

  it('disables after a fatal build error and discards future spans', () => {
    const error = new Error('build failed')
    error.name = 'NativeExporterBuildError'
    nativeSpans.flushSpansGrouped.callsFake((_groups, done) => done(error))
    const exporter = new NativeExporter(config, prioritySampler, nativeSpans)

    exporter.export([createMockSpan(1)])
    exporter.flush()
    exporter.export([createMockSpan(2)])

    sinon.assert.calledOnce(nativeSpans.flushSpansGrouped)
    sinon.assert.calledOnce(nativeSpans.discardSpansGrouped)
  })

  it('defers URL replacement until active spans and sends drain', () => {
    let finishSend
    nativeSpans.flushSpansGrouped.callsFake((_groups, done) => { finishSend = done })
    const exporter = new NativeExporter(config, prioritySampler, nativeSpans)

    exporter._trackSpanStart()
    exporter.export([createMockSpan(1)])
    exporter.setUrl('http://new-agent:9126')
    exporter._trackSpanFinish()

    sinon.assert.notCalled(nativeSpans.setAgentUrl)
    finishSend(undefined, 'unchanged')
    sinon.assert.calledOnceWithExactly(nativeSpans.setAgentUrl, 'http://new-agent:9126/')
  })

  it('publishes the first-flush channel exactly once', () => {
    const firstFlush = channel('dd-trace:exporter:first-flush')
    const subscriber = sinon.stub()
    firstFlush.subscribe(subscriber)
    config.flushInterval = 0

    try {
      const exporter = new NativeExporter(config, prioritySampler, nativeSpans)
      exporter.export([createMockSpan(1), createMockSpan(2)])
      sinon.assert.calledOnce(subscriber)
    } finally {
      firstFlush.unsubscribe(subscriber)
    }
  })
})
