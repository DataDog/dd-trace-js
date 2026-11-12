'use strict'

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

describe('Test Optimization telemetry', () => {
  let count
  let incrementCountMetric
  let namespace

  beforeEach(() => {
    count = { inc: sinon.stub() }
    namespace = { count: sinon.stub().returns(count) }
    const telemetry = proxyquire('../../src/ci-visibility/telemetry', {
      '../telemetry/metrics': { manager: { namespace: sinon.stub().returns(namespace) } },
    })
    incrementCountMetric = telemetry.incrementCountMetric
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
})
