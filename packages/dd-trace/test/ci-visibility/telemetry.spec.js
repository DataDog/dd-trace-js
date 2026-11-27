'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

describe('Test Optimization telemetry', () => {
  let count
  let incrementCountMetric
  let monotonicNow
  let namespace

  beforeEach(() => {
    count = { inc: sinon.stub() }
    namespace = { count: sinon.stub().returns(count) }
    const telemetry = proxyquire('../../src/ci-visibility/telemetry', {
      '../telemetry/metrics': { manager: { namespace: sinon.stub().returns(namespace) } },
    })
    incrementCountMetric = telemetry.incrementCountMetric
    monotonicNow = telemetry.monotonicNow
  })

  it('reports the HTTP status and status class for endpoint failures', () => {
    incrementCountMetric('endpoint_payload.requests_errors', {
      endpoint: 'test_cycle',
      statusCode: 503,
      errorType: undefined,
    })

    sinon.assert.calledOnceWithExactly(namespace.count, 'endpoint_payload.requests_errors', [
      'endpoint:test_cycle',
      'status_code:503',
      'error_type:status_code_5xx_response',
    ])
  })

  it('reports the underlying network error type when there is no HTTP response', () => {
    incrementCountMetric('endpoint_payload.requests_errors', {
      endpoint: 'test_cycle',
      statusCode: undefined,
      errorType: 'ECONNRESET',
    })

    sinon.assert.calledOnceWithExactly(namespace.count, 'endpoint_payload.requests_errors', [
      'endpoint:test_cycle',
      'error_type:ECONNRESET',
    ])
  })

  it('falls back to the generic network classification without a specific error type', () => {
    incrementCountMetric('endpoint_payload.requests_errors', {
      endpoint: 'test_cycle',
      statusCode: undefined,
      errorType: undefined,
    })

    sinon.assert.calledOnceWithExactly(namespace.count, 'endpoint_payload.requests_errors', [
      'endpoint:test_cycle',
      'error_type:network',
    ])
  })

  it('ignores fake timers when measuring elapsed durations with monotonicNow', () => {
    const clock = sinon.useFakeTimers({
      now: 0,
      toFake: ['Date', 'performance', 'hrtime'],
    })

    try {
      const start = monotonicNow()
      const fakeDateStart = Date.now()
      const fakePerfStart = globalThis.performance.now()
      const fakeHrtimeStart = process.hrtime.bigint()

      clock.tick(1_000_000_000)

      const elapsed = monotonicNow() - start

      assert.strictEqual(Date.now() - fakeDateStart, 1_000_000_000)
      assert.strictEqual(globalThis.performance.now() - fakePerfStart, 1_000_000_000)
      assert.strictEqual(process.hrtime.bigint() - fakeHrtimeStart, 1_000_000_000_000_000n)
      assert.ok(elapsed >= 0 && elapsed < 10_000, `Expected real monotonic elapsed ms, got ${elapsed}`)
    } finally {
      clock.restore()
    }
  })
})
