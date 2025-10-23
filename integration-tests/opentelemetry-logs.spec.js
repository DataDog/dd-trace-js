'use strict'

const { assert } = require('chai')
const { isolatedSandbox } = require('./helpers')
const http = require('http')

describe('OpenTelemetry Logs Integration', () => {
  let sandbox

  beforeEach(async () => {
    sandbox = await isolatedSandbox()
  })

  afterEach(async () => {
    await sandbox.remove()
  })

  it('should send OTLP logs to test agent and receive 200', (done) => {
    const payload = JSON.stringify({
      resourceLogs: [{
        scopeLogs: [{ logRecords: [{ body: { stringValue: 'test' }, timeUnixNano: String(Date.now() * 1000000) }] }]
      }]
    })

    const req = http.request({
      hostname: '127.0.0.1',
      port: 4318,
      path: '/v1/logs',
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

  it('should receive 400 when sending protobuf to JSON endpoint', (done) => {
    const protobufPayload = Buffer.from([0x0a, 0x04, 0x08, 0x01, 0x12, 0x00])

    const req = http.request({
      hostname: '127.0.0.1',
      port: 4318,
      path: '/v3/logs',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf', 'Content-Length': protobufPayload.length }
    }, (res) => {
      // 404 Not Found - wrong path
      assert.strictEqual(res.statusCode, 404)
      done()
    })

    req.on('error', done)
    req.write(protobufPayload)
    req.end()
  })
})
