'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const { channel } = require('dc-polyfill')

require('../../setup/core')

const { OtlpStatsExporter } = require('../../../src/opentelemetry/metrics/otlp_span_stats_exporter')
const { buildResourceAttributes, createOtlpSpanStatsExporter } = require('../../../src/opentelemetry/metrics')
const { SpanBuckets } = require('../../../src/span_stats')
const { HTTP_STATUS_CODE } = require('../../../../../ext/tags')

const identityRefreshChannel = channel('datadog:identity:refresh')

const RESOURCE_ATTRS = { 'service.name': 'svc' }
const BUCKET_SIZE_NS = 10 * 1e9

function makeSpan (overrides = {}) {
  return {
    startTime: 12345 * 1e9,
    duration: 1000,
    error: 0,
    name: 'op',
    service: 'svc',
    resource: 'res',
    type: 'web',
    meta: { [HTTP_STATUS_CODE]: 200 },
    metrics: {},
    ...overrides,
  }
}

function makeDrained (spans) {
  const bucket = new SpanBuckets()
  for (const span of spans) {
    bucket.forSpan(span).record(span)
  }
  return [{ timeNs: 12340000000000, bucket }]
}

describe('buildResourceAttributes', () => {
  it('includes sdk identity and maps service/env/version to OTel attributes', () => {
    const attrs = buildResourceAttributes({}, { service: 'my-svc', env: 'prod', serviceVersion: '1.0.0' })

    assert.strictEqual(attrs['telemetry.sdk.name'], 'datadog')
    assert.strictEqual(attrs['telemetry.sdk.language'], 'nodejs')
    assert.strictEqual(typeof attrs['telemetry.sdk.version'], 'string')
    assert.strictEqual(attrs['service.name'], 'my-svc')
    assert.strictEqual(attrs['deployment.environment.name'], 'prod')
    assert.strictEqual(attrs['service.version'], '1.0.0')
  })

  it('includes datadog.runtime_id from tags when otelSemanticsEnabled is false', () => {
    const attrs = buildResourceAttributes({ 'runtime-id': 'abc-123' }, { otelSemanticsEnabled: false })
    assert.strictEqual(attrs['datadog.runtime_id'], 'abc-123')
  })

  it('omits dd.* attributes when otelSemanticsEnabled is true', () => {
    const attrs = buildResourceAttributes({ 'runtime-id': 'abc-123' }, { otelSemanticsEnabled: true })
    assert.ok(!Object.keys(attrs).some(k => k.startsWith('datadog.')))
  })
})

describe('createOtlpSpanStatsExporter', () => {
  let httpStub

  beforeEach(() => {
    httpStub = sinon.stub(http, 'request').returns({
      write: sinon.stub(), end: sinon.stub(), on: sinon.stub(), once: sinon.stub(),
    })
  })

  afterEach(() => httpStub.restore())

  it('returns an OtlpStatsExporter configured from config', () => {
    const exporter = createOtlpSpanStatsExporter({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://localhost:4318/v1/metrics',
      service: 'svc',
    })
    assert.ok(exporter instanceof OtlpStatsExporter)
  })

  it('recomputes resource attributes when the identity-refresh channel fires', () => {
    const config = {
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://localhost:4318/v1/metrics',
      service: 'svc',
      tags: { 'runtime-id': 'initial-id' },
    }
    const exporter = createOtlpSpanStatsExporter(config)
    const updateSpy = sinon.spy(exporter, 'updateResourceAttributes')

    // Simulates `proxy.js#refreshIdentity` mutating `config.tags['runtime-id']` in place and
    // then publishing to the shared identity-refresh channel (MicroVM clone resume).
    config.tags['runtime-id'] = 'refreshed-id'
    identityRefreshChannel.publish(config)

    sinon.assert.calledOnce(updateSpy)
    assert.strictEqual(updateSpy.firstCall.args[0]['datadog.runtime_id'], 'refreshed-id')
  })

  it('replaces the previous identity-refresh subscription so listeners do not accumulate', () => {
    const config = {
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://localhost:4318/v1/metrics',
      service: 'svc',
      tags: { 'runtime-id': 'a' },
    }
    const firstExporter = createOtlpSpanStatsExporter(config)
    const firstSpy = sinon.spy(firstExporter, 'updateResourceAttributes')

    const secondExporter = createOtlpSpanStatsExporter(config)
    const secondSpy = sinon.spy(secondExporter, 'updateResourceAttributes')

    identityRefreshChannel.publish(config)

    sinon.assert.notCalled(firstSpy)
    sinon.assert.calledOnce(secondSpy)
  })
})

describe('OtlpStatsExporter', () => {
  let exporter
  let httpStub
  let mockReq

  beforeEach(() => {
    mockReq = {
      write: sinon.stub(),
      end: sinon.stub(),
      on: sinon.stub(),
      once: sinon.stub(),
    }

    httpStub = sinon.stub(http, 'request').callsFake((options, callback) => {
      const mockRes = {
        statusCode: 200,
        on: sinon.stub(),
        once: (event, handler) => {
          if (event === 'end') handler()
          return mockRes
        },
      }
      if (callback) callback(mockRes)
      return mockReq
    })

    exporter = new OtlpStatsExporter('http://localhost:4318/v1/metrics', 'http/json', RESOURCE_ATTRS)
  })

  afterEach(() => {
    httpStub.restore()
  })

  it('sends a POST to /v1/metrics', () => {
    const drained = makeDrained([makeSpan()])
    exporter.export(drained, BUCKET_SIZE_NS)

    assert.ok(httpStub.calledOnce)
    const options = httpStub.firstCall.args[0]
    assert.strictEqual(options.method, 'POST')
    assert.strictEqual(options.path, '/v1/metrics')
  })

  it('sends a JSON payload containing the single duration histogram metric', () => {
    const drained = makeDrained([makeSpan()])
    exporter.export(drained, BUCKET_SIZE_NS)

    const payload = JSON.parse(mockReq.write.firstCall.args[0].toString())
    const { metrics } = payload.resourceMetrics[0].scopeMetrics[0]
    assert.strictEqual(metrics.length, 1)
    assert.strictEqual(metrics[0].name, 'traces.span.sdk.metrics.duration')
  })

  it('returns early when drained is empty', () => {
    exporter.export([], BUCKET_SIZE_NS)
    assert.ok(httpStub.notCalled)
  })

  it('uses http/json Content-Type', () => {
    const drained = makeDrained([makeSpan()])
    exporter.export(drained, BUCKET_SIZE_NS)

    const options = httpStub.firstCall.args[0]
    assert.strictEqual(options.headers['Content-Type'], 'application/json')
  })

  it('uses http/protobuf Content-Type when protocol is http/protobuf', () => {
    const protoExporter = new OtlpStatsExporter('http://localhost:4318/v1/metrics', 'http/protobuf', RESOURCE_ATTRS)
    const drained = makeDrained([makeSpan()])
    protoExporter.export(drained, BUCKET_SIZE_NS)

    const options = httpStub.firstCall.args[0]
    assert.strictEqual(options.headers['Content-Type'], 'application/x-protobuf')
  })

  it('logs an error on non-2xx HTTP response', () => {
    httpStub.callsFake((options, callback) => {
      const mockRes = {
        statusCode: 500,
        on: (event, handler) => { if (event === 'data') handler('err body') },
        once: (event, handler) => { if (event === 'end') handler() },
      }
      if (callback) callback(mockRes)
      return mockReq
    })

    const drained = makeDrained([makeSpan()])
    exporter.export(drained, BUCKET_SIZE_NS)
    assert.ok(httpStub.calledOnce)
  })

  it('handles request error without throwing', () => {
    mockReq.on = (event, handler) => { if (event === 'error') handler(new Error('connection refused')) }

    const drained = makeDrained([makeSpan()])
    exporter.export(drained, BUCKET_SIZE_NS)
    assert.ok(httpStub.calledOnce)
  })
})
