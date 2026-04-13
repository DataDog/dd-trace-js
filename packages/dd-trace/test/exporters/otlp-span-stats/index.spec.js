'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')
const { SpanAggStats, SpanAggKey } = require('../../../src/span_stats')
const { HTTP_STATUS_CODE } = require('../../../../../ext/tags')

const basicSpan = {
  startTime: 10000 * 1e9,
  duration: 5000,
  error: 0,
  name: 'http.request',
  service: 'web-service',
  resource: '/users',
  type: 'web',
  meta: { [HTTP_STATUS_CODE]: 200 },
  metrics: {},
}

const resourceAttributes = {
  'service.name': 'web-service',
  'deployment.environment': 'test',
}

function makeDrained (count = 1) {
  const aggKey = new SpanAggKey(basicSpan)
  const aggStats = new SpanAggStats(aggKey)
  for (let i = 0; i < count; i++) aggStats.record(basicSpan)
  const bucket = new Map([[aggKey.toString(), aggStats]])
  return [{ timeNs: 10000 * 1e9, bucket }]
}

const BUCKET_SIZE_NS = 10 * 1e9

describe('OtlpSpanStatsExporter', () => {
  let sendPayloadStub
  let recordTelemetryStub
  let fakeMetricsExporter
  let OtlpSpanStatsExporter

  beforeEach(() => {
    sendPayloadStub = sinon.stub()
    recordTelemetryStub = sinon.stub()

    fakeMetricsExporter = {
      protocol: 'http/protobuf',
      sendPayload: sendPayloadStub,
      recordTelemetry: recordTelemetryStub,
    }

    const FakeTransformer = {
      transform: sinon.stub().returns(Buffer.from('payload')),
    }
    const FakeTransformerClass = sinon.stub().returns(FakeTransformer)
    const FakeMetricExporterClass = sinon.stub().returns(fakeMetricsExporter)

    const mod = proxyquire('../../../src/exporters/otlp-span-stats/index', {
      './transformer': FakeTransformerClass,
      '../../opentelemetry/metrics/otlp_http_metric_exporter': FakeMetricExporterClass,
    })
    OtlpSpanStatsExporter = mod.OtlpSpanStatsExporter
  })

  afterEach(() => {
    sinon.restore()
  })

  it('should construct without error', () => {
    const exporter = new OtlpSpanStatsExporter(
      { url: 'http://localhost:4318/v1/metrics', protocol: 'http/protobuf', histogramType: 'explicit' },
      resourceAttributes
    )
    assert.ok(exporter)
  })

  it('should not send if drained is empty', () => {
    const exporter = new OtlpSpanStatsExporter(
      { url: 'http://localhost:4318/v1/metrics', protocol: 'http/protobuf', histogramType: 'explicit' },
      resourceAttributes
    )
    exporter.export([], BUCKET_SIZE_NS)
    assert.strictEqual(sendPayloadStub.callCount, 0)
    assert.strictEqual(recordTelemetryStub.callCount, 0)
  })

  it('should call sendPayload on _metricsExporter with transformer output', () => {
    const exporter = new OtlpSpanStatsExporter(
      { url: 'http://localhost:4318/v1/metrics', protocol: 'http/protobuf', histogramType: 'explicit' },
      resourceAttributes
    )
    const drained = makeDrained(3)
    exporter.export(drained, BUCKET_SIZE_NS)
    assert.strictEqual(sendPayloadStub.callCount, 1)
    assert.deepStrictEqual(sendPayloadStub.firstCall.args[0], Buffer.from('payload'))
  })

  it('should record attempt telemetry before sending', () => {
    const exporter = new OtlpSpanStatsExporter(
      { url: 'http://localhost:4318/v1/metrics', protocol: 'http/protobuf', histogramType: 'explicit' },
      resourceAttributes
    )
    const drained = makeDrained(2)
    exporter.export(drained, BUCKET_SIZE_NS)
    const attemptCall = recordTelemetryStub.getCalls().find(c => c.args[0] === 'otel.span_stats_export_attempts')
    assert.ok(attemptCall, 'should record attempt telemetry')
    assert.strictEqual(attemptCall.args[1], 1)
  })

  it('should record success telemetry on 2xx response', () => {
    sendPayloadStub.callsFake((payload, cb) => cb({ code: 0 }))
    const exporter = new OtlpSpanStatsExporter(
      { url: 'http://localhost:4318/v1/metrics', protocol: 'http/protobuf', histogramType: 'explicit' },
      resourceAttributes
    )
    const drained = makeDrained()
    exporter.export(drained, BUCKET_SIZE_NS)
    const successCall = recordTelemetryStub.getCalls().find(c => c.args[0] === 'otel.span_stats_export_successes')
    assert.ok(successCall, 'should record success telemetry')
  })

  it('should not record success telemetry on failure', () => {
    sendPayloadStub.callsFake((payload, cb) => cb({ code: 1, error: new Error('timeout') }))
    const exporter = new OtlpSpanStatsExporter(
      { url: 'http://localhost:4318/v1/metrics', protocol: 'http/protobuf', histogramType: 'explicit' },
      resourceAttributes
    )
    const drained = makeDrained()
    exporter.export(drained, BUCKET_SIZE_NS)

    const successCalls = recordTelemetryStub.getCalls().filter(c => c.args[0] === 'otel.span_stats_export_successes')
    assert.strictEqual(successCalls.length, 0)
  })

  it('should include points tag in telemetry', () => {
    const exporter = new OtlpSpanStatsExporter(
      { url: 'http://localhost:4318/v1/metrics', protocol: 'http/protobuf', histogramType: 'explicit' },
      resourceAttributes
    )
    const drained = makeDrained()
    exporter.export(drained, BUCKET_SIZE_NS)
    const attemptCall = recordTelemetryStub.getCalls().find(c => c.args[0] === 'otel.span_stats_export_attempts')
    assert.ok(attemptCall.args[2].includes('points:1'))
  })
})
