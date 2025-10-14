'use strict'

const { assert } = require('chai')
const { createSandbox } = require('./helpers')
const http = require('http')

describe('OpenTelemetry Metrics Integration', () => {
  let sandbox

  beforeEach(async () => {
    sandbox = await createSandbox()
  })

  afterEach(async () => {
    await sandbox.remove()
  })

  it('should send OTLP metrics to test agent and receive 200', (done) => {
    const payload = JSON.stringify({
      resourceMetrics: [{
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'test-service' } }]
        },
        scopeMetrics: [{
          scope: { name: 'test-meter', version: '1.0.0' },
          metrics: [{
            name: 'test.counter',
            sum: {
              dataPoints: [{
                attributes: [],
                timeUnixNano: String(Date.now() * 1000000),
                asInt: '1'
              }],
              aggregationTemporality: 'AGGREGATION_TEMPORALITY_DELTA',
              isMonotonic: true
            }
          }]
        }]
      }]
    })

    const req = http.request({
      hostname: '127.0.0.1',
      port: 4318,
      path: '/v1/metrics',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
    }, (res) => {
      assert.strictEqual(res.statusCode, 200)
      done()
    })

    req.on('error', done)
    req.write(payload)
    req.end()
  })

  it('should receive 404 for wrong path', (done) => {
    const payload = JSON.stringify({
      resourceMetrics: [{
        scopeMetrics: [{ metrics: [{ name: 'test' }] }]
      }]
    })

    const req = http.request({
      hostname: '127.0.0.1',
      port: 4318,
      path: '/v3/metrics', // Wrong path
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
    }, (res) => {
      assert.strictEqual(res.statusCode, 404)
      done()
    })

    req.on('error', done)
    req.write(payload)
    req.end()
  })
})
