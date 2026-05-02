'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')

const { OtlpStatsExporter } = require('../../../src/exporters/otlp-span-stats')
const { SpanBuckets } = require('../../../src/span_stats')
const { HTTP_STATUS_CODE } = require('../../../../../ext/tags')

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

  it('sends a JSON payload containing the 4 metrics', () => {
    const drained = makeDrained([makeSpan()])
    exporter.export(drained, BUCKET_SIZE_NS)

    const payload = JSON.parse(mockReq.write.firstCall.args[0].toString())
    const { metrics } = payload.resourceMetrics[0].scopeMetrics[0]
    assert.strictEqual(metrics.length, 4)
    assert.strictEqual(metrics[0].name, 'dd.trace.span.hits')
    assert.strictEqual(metrics[3].name, 'dd.trace.span.duration')
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
})
