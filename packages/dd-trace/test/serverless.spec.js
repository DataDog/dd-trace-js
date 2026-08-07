'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')

const { describe, it, afterEach } = require('mocha')
const { logs } = require('@opentelemetry/api-logs')
const { metrics } = require('@opentelemetry/api')

require('./setup/core')

const { enableGCPPubSubPushSubscription, getVercelRequestEndHandler } = require('../src/serverless')
const Tracer = require('../src/tracer')
const { getConfigFresh } = require('./helpers/config')
const { getLoggerProvider, initializeOpenTelemetryLogs } = require('../src/opentelemetry/logs')
const { getMeterProvider, initializeOpenTelemetryMetrics } = require('../src/opentelemetry/metrics')

describe('enableGCPPubSubPushSubscription', () => {
  const originalKService = process.env.K_SERVICE
  const originalGcpPubsubPush = process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED

  afterEach(() => {
    if (originalKService === undefined) delete process.env.K_SERVICE
    else process.env.K_SERVICE = originalKService
    if (originalGcpPubsubPush === undefined) delete process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED
    else process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED = originalGcpPubsubPush
  })

  it('is false when K_SERVICE is not set', () => {
    delete process.env.K_SERVICE
    assert.strictEqual(enableGCPPubSubPushSubscription(), false)
  })

  it('is true when K_SERVICE is set and the env var defaults to true', () => {
    process.env.K_SERVICE = 'svc'
    delete process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED
    assert.strictEqual(enableGCPPubSubPushSubscription(), true)
  })

  it('is false when the user opts out via DD_TRACE_GCP_PUBSUB_PUSH_ENABLED=false', () => {
    process.env.K_SERVICE = 'svc'
    process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED = 'false'
    assert.strictEqual(enableGCPPubSubPushSubscription(), false)
  })
})

describe('getVercelRequestEndHandler', () => {
  const requestContext = Symbol.for('@vercel/request-context')
  const originalVercel = process.env.VERCEL
  const originalContext = globalThis[requestContext]
  const endpointVariables = [
    'DD_LOGS_OTEL_ENABLED',
    'DD_METRICS_OTEL_ENABLED',
    'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  ]
  const originalEndpoints = Object.fromEntries(endpointVariables.map(name => [name, process.env[name]]))

  afterEach(() => {
    if (originalVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = originalVercel

    if (originalContext === undefined) delete globalThis[requestContext]
    else globalThis[requestContext] = originalContext

    for (const name of endpointVariables) {
      if (originalEndpoints[name] === undefined) delete process.env[name]
      else process.env[name] = originalEndpoints[name]
    }

    logs.disable()
    metrics.disable()
  })

  it('retains a Vercel request until trace, log, and metric payloads reach the intake', async () => {
    process.env.VERCEL = '1'
    process.env.DD_LOGS_OTEL_ENABLED = 'true'
    process.env.DD_METRICS_OTEL_ENABLED = 'true'
    const received = new Set()
    let intakeReceived
    const intake = http.createServer((req, res) => {
      req.resume()
      req.once('end', () => {
        if (req.url === '/v1/logs') received.add('logs')
        if (req.url === '/v1/metrics') received.add('metrics')
        if (req.url?.startsWith('/v0.')) received.add('traces')
        res.end()
        if (received.size === 3) intakeReceived()
      })
    })
    await new Promise(resolve => intake.listen(0, '127.0.0.1', resolve))
    const { port } = intake.address()
    const endpoint = `http://127.0.0.1:${port}`
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `${endpoint}/v1/logs`
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `${endpoint}/v1/metrics`

    let retained
    globalThis[requestContext] = {
      get: () => ({ waitUntil: promise => { retained = promise } }),
    }
    const intakeRequests = new Promise(resolve => { intakeReceived = resolve })

    try {
      const config = getConfigFresh({ service: 'serverless-flush', url: endpoint })
      const tracer = new Tracer(config)
      initializeOpenTelemetryLogs(config)
      initializeOpenTelemetryMetrics(config)

      tracer.trace('serverless.flush', {}, () => {})
      logs.getLogger('serverless-flush').emit({ body: 'flush me' })
      metrics.getMeter('serverless-flush').createCounter('flush.me').add(1)

      const onRequestEnd = getVercelRequestEndHandler(tracer)
      assert.strictEqual(onRequestEnd(), true)
      await Promise.race([
        intakeRequests,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`Missing intake signals: ${[...received].join(', ')}`)),
          1000
        )),
      ])

      await Promise.race([
        retained,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('waitUntil did not resolve after all intake responses completed')),
          1000
        )),
      ])
      assert.deepStrictEqual(received, new Set(['traces', 'logs', 'metrics']))
    } finally {
      getMeterProvider()?.reader?.shutdown()
      getLoggerProvider()?.shutdown?.()
      intake.closeAllConnections()
      intake.close()
    }
  })
})
