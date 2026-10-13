'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')
const telemetryMetrics = require('../../../src/telemetry/metrics')

describe('flag evaluation consumer delivery ownership', () => {
  let writer
  let requests
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    requests = []
    const Base = proxyquire('../../../src/openfeature/writers/base', {
      '../../exporters/common/request': (payload, options, callback) => {
        requests.push({ payload, options, callback })
      },
    })
    const Consumer = proxyquire('../../../src/openfeature/writers/flag-evaluation-consumer', { './base': Base })
    writer = new Consumer({ url: new URL('http://localhost:8126'), service: 'test' })
    writer.setEnabled(true)
  })

  afterEach(() => {
    writer.destroy()
    clock.restore()
    telemetryMetrics.manager.namespace('general').reset()
  })

  for (const result of [202, 400, 500, 'ECONNRESET', 'ERR_DD_REQUEST_BUFFER_FULL']) {
    it(`reports final delivery outcome ${result} for every aggregated evaluation`, () => {
      for (let i = 0; i < 3; i++) writer.enqueue({ flagKey: 'flag', timestamp: 100 })
      writer.flush()
      assert.strictEqual(JSON.parse(requests[0].payload).flagEvaluations[0].evaluation_count, 3)
      const error = typeof result === 'string' ? Object.assign(new Error(result), { code: result }) : null
      requests[0].callback(error, '', typeof result === 'number' ? result : undefined)
      const series = telemetryMetrics.manager.namespace('general').toJSON().metrics?.series ?? []
      const drops = series.filter(metric => metric.metric === 'flagevaluation.rows.dropped')
      assert.deepStrictEqual(drops.map(metric => ({ tags: metric.tags, count: metric.points[0][1] })),
        result === 202 ? [] : [{ tags: ['reason:delivery_failure'], count: 3 }])
    })
  }

  it('bounds pending encoded bytes and drains a healthy large flush without losing its tail', () => {
    for (let i = 0; i < 15; i++) {
      writer.enqueue({ flagKey: String(i) + 'x'.repeat(900000), timestamp: 100 })
    }
    writer.flush()
    assert.strictEqual(requests.length, 2)
    assert.ok(requests.reduce((sum, request) => sum + Buffer.byteLength(request.payload), 0) <= 10 * 1024 * 1024)
    const series = telemetryMetrics.manager.namespace('general').toJSON().metrics?.series ?? []
    assert.strictEqual(series.some(metric => metric.metric === 'flagevaluation.rows.dropped'), false)
    requests[0].callback(new Error('failed'), undefined, 500)
    assert.strictEqual(requests.length, 3)
    assert.strictEqual(JSON.parse(requests[2].payload).flagEvaluations.length, 5)
    writer.enqueue({ flagKey: 'next', timestamp: 100 })
    writer.flush()
    requests[1].callback(null, '', 202)
    requests[2].callback(null, '', 202)
    assert.strictEqual(requests.length, 4)
    requests[3].callback(null, '', 202)
  })

  it('does not let an old in-flight fallback overwrite a newer route', () => {
    const url = new URL('http://localhost:8126')
    const onFallback = sinon.spy()
    writer.setEnabled(true, { url, basePath: '/old', fallback: { url, basePath: '/fallback' }, onFallback })
    writer.enqueue({ flagKey: 'old', timestamp: 100 })
    writer.flush()
    writer.setEnabled(true, { url, basePath: '/new' })
    requests[0].callback(null, '', 405)
    sinon.assert.notCalled(onFallback)
    assert.strictEqual(requests[1].options.path, '/fallback/api/v2/flagevaluation')
    requests[1].callback(null, '', 202)
    writer.enqueue({ flagKey: 'new', timestamp: 100 })
    writer.flush()
    assert.strictEqual(requests[2].options.path, '/new/api/v2/flagevaluation')
    requests[2].callback(null, '', 202)
  })

  it('does not report unavailability from an obsolete route', () => {
    const url = new URL('http://localhost:8126')
    const onUnavailable = sinon.spy()
    writer.setEnabled(true, { url, basePath: '/old', onUnavailable })
    writer.enqueue({ flagKey: 'old', timestamp: 100 })
    writer.flush()
    writer.setEnabled(true, { url, basePath: '/new', onUnavailable })
    requests[0].callback(null, '', 503)
    sinon.assert.notCalled(onUnavailable)
    writer.enqueue({ flagKey: 'new', timestamp: 100 })
    writer.flush()
    requests[1].callback(null, '', 503)
    sinon.assert.calledOnce(onUnavailable)
  })

  it('settles unsent snapshot and current aggregate counts when disabled without resending in-flight work', () => {
    for (let i = 0; i < 15; i++) writer.enqueue({ flagKey: String(i) + 'x'.repeat(900000), timestamp: 100 })
    writer.flush()
    writer.enqueue({ flagKey: 'current', timestamp: 100 })
    writer.flush()
    writer.setEnabled(false)
    const dropped = telemetryMetrics.manager.namespace('general').toJSON().metrics.series.find(metric =>
      metric.metric === 'flagevaluation.rows.dropped' && metric.tags.includes('reason:unavailable'))
    assert.strictEqual(dropped.points[0][1], 6)
    requests[0].callback(null, '', 202)
    requests[1].callback(null, '', 202)
    assert.strictEqual(requests.length, 2)
    writer.setEnabled(true)
    writer.enqueue({ flagKey: 'new', timestamp: 100 })
    writer.flush()
    assert.strictEqual(requests.length, 3)
    requests[2].callback(null, '', 202)
  })

  it('drains both a blocked snapshot and the current aggregate on shutdown', () => {
    for (let i = 0; i < 15; i++) writer.enqueue({ flagKey: String(i) + 'x'.repeat(900000), timestamp: 100 })
    writer.flush()
    writer.enqueue({ flagKey: 'current', timestamp: 100 })
    writer.destroy()
    assert.strictEqual(requests.length, 2)
    requests[0].callback(null, '', 202)
    requests[1].callback(null, '', 202)
    requests[2].callback(null, '', 202)
    requests[3].callback(null, '', 202)
    assert.strictEqual(requests.length, 4)
    const rows = requests.flatMap(request => JSON.parse(request.payload).flagEvaluations)
    assert.strictEqual(rows.reduce((sum, row) => sum + row.evaluation_count, 0), 16)
    assert.strictEqual(rows.at(-1).flag.key, 'current')
  })
})
