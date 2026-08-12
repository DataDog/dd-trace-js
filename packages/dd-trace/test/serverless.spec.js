'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')

const { describe, it, afterEach } = require('mocha')
const { logs } = require('@opentelemetry/api-logs')
const { metrics } = require('@opentelemetry/api')
const { channel } = require('dc-polyfill')

require('./setup/core')

const {
  getServerlessPlatformTags,
  getServerlessPlatform,
  enableGCPPubSubPushSubscription,
  getVercelRequestEndHandler,
  registerVercelTelemetryRetention,
} = require('../src/serverless')
const Tracer = require('../src/tracer')
const { initializeOpenTelemetryLogs } = require('../src/opentelemetry/logs')
const { initializeOpenTelemetryMetrics } = require('../src/opentelemetry/metrics')
const agent = require('./plugins/agent')
const { getConfigFresh } = require('./helpers/config')

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

describe('Vercel span metadata', () => {
  const environment = process.env

  afterEach(async () => {
    process.env = environment
    await agent.close()
  })

  it('does not add tags outside Vercel', async () => {
    process.env = {
      ...environment,
      VERCEL_DEPLOYMENT_ID: 'dpl_123',
      VERCEL_ENV: 'preview',
      VERCEL_PROJECT_ID: 'prj_123',
      VERCEL_REGION: 'iad1',
      VERCEL_TARGET_ENV: 'staging',
    }
    delete process.env.VERCEL

    const tracer = await agent.load([], [], { service: 'vercel-metadata-test' })
    tracer.startSpan('non-vercel-span').finish()

    await agent.assertSomeTraces(traces => {
      const { meta } = traces[0][0]
      assert.strictEqual(meta['vercel.project_id'], undefined)
      assert.strictEqual(meta['vercel.environment'], undefined)
      assert.strictEqual(meta['vercel.region'], undefined)
    })
  })

  it('adds present Vercel metadata to encoded spans', async () => {
    process.env = {
      ...environment,
      VERCEL: '1',
      VERCEL_DEPLOYMENT_ID: 'dpl_123',
      VERCEL_ENV: 'preview',
      VERCEL_PROJECT_ID: 'prj_123',
      VERCEL_REGION: 'iad1',
      VERCEL_TARGET_ENV: 'staging',
    }

    const tracer = await agent.load([], [], {
      service: 'vercel-metadata-test',
      tags: { 'vercel.region': 'custom-region' },
    })
    tracer.startSpan('vercel-span').finish()

    await agent.assertSomeTraces(traces => {
      assert.deepStrictEqual(Object.fromEntries(
        Object.entries(traces[0][0].meta).filter(([name]) => name.startsWith('vercel.'))
      ), {
        'vercel.project_id': 'prj_123',
        'vercel.environment': 'preview',
        'vercel.region': 'custom-region',
      })
    })
  })

  it('discovers only present Vercel metadata as platform tags', () => {
    process.env = {
      ...environment,
      VERCEL: '1',
      VERCEL_ENV: 'preview',
      VERCEL_PROJECT_ID: 'prj_123',
    }

    assert.deepStrictEqual(getServerlessPlatformTags(), [
      'vercel.project_id', 'prj_123',
      'vercel.environment', 'preview',
    ])
  })

  it('discovers Vercel metadata when project ID is missing', () => {
    process.env = {
      ...environment,
      VERCEL: '1',
      VERCEL_ENV: 'preview',
    }

    assert.deepStrictEqual(getServerlessPlatformTags(), [
      'vercel.environment', 'preview',
    ])
  })

  it('records the Vercel environment in configuration', () => {
    process.env = { ...environment, VERCEL: '1' }

    assert.strictEqual(getServerlessPlatform().isVercel, true)
  })
})

describe('Vercel telemetry retention', () => {
  const requestContext = Symbol.for('@vercel/request-context')
  const originalContext = globalThis[requestContext]
  const endpointVariables = [
    'VERCEL',
    'OTEL_TRACES_EXPORTER',
    'DD_LOGS_OTEL_ENABLED',
    'DD_METRICS_OTEL_ENABLED',
    'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  ]
  const originalEndpoints = Object.fromEntries(endpointVariables.map(name => [name, process.env[name]]))

  afterEach(() => {
    if (originalContext === undefined) delete globalThis[requestContext]
    else globalThis[requestContext] = originalContext
    for (const name of endpointVariables) {
      if (originalEndpoints[name] === undefined) delete process.env[name]
      else process.env[name] = originalEndpoints[name]
    }
    logs.disable()
    metrics.disable()
  })

  it('retains trace, log, and metric payloads until their intake responses complete', async () => {
    process.env.OTEL_TRACES_EXPORTER = 'otlp'
    process.env.DD_LOGS_OTEL_ENABLED = 'true'
    process.env.DD_METRICS_OTEL_ENABLED = 'true'
    const received = new Set()
    let intakeReceived
    const intake = http.createServer((req, res) => {
      req.resume()
      req.once('end', () => {
        if (req.url === '/v1/logs') received.add('logs')
        if (req.url === '/v1/metrics') received.add('metrics')
        if (req.url === '/v1/traces') received.add('traces')
        res.end()
        if (received.size === 3) intakeReceived()
      })
    })
    await new Promise(resolve => intake.listen(0, '127.0.0.1', resolve))
    const { port } = intake.address()
    const endpoint = `http://127.0.0.1:${port}`
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${endpoint}/v1/traces`
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `${endpoint}/v1/logs`
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `${endpoint}/v1/metrics`

    let retained
    globalThis[requestContext] = {
      get: () => ({ waitUntil: promise => { retained = promise } }),
    }
    const intakeRequests = new Promise(resolve => { intakeReceived = resolve })

    try {
      const config = getConfigFresh({ service: 'serverless-flush' })
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
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Missing intake signals')), 1000)),
      ])
      await retained
      assert.deepStrictEqual(received, new Set(['traces', 'logs', 'metrics']))
    } finally {
      metrics.getMeterProvider()?.reader?.shutdown()
      logs.getLoggerProvider()?.shutdown?.()
      await new Promise(resolve => intake.close(resolve))
    }
  })

  it('registers retention through tracer configuration', async () => {
    let retained
    globalThis[requestContext] = {
      get: () => ({ waitUntil: promise => { retained = promise } }),
    }
    const config = getConfigFresh({ service: 'serverless-disabled' })
    process.env.VERCEL = '1'
    const tracer = new Tracer(config)
    tracer.flushAll = done => done()
    tracer.configure(config)
    const server = http.createServer((req, res) => res.end())

    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${server.address().port}`, res => {
        res.resume()
        res.once('end', resolve)
      }).once('error', reject))
      await retained
    } finally {
      server.closeAllConnections?.()
      server.close()
    }
  })

  it('registers retention through the HTTP/2 response close event', async () => {
    let retained
    globalThis[requestContext] = {
      get: () => ({ waitUntil: promise => { retained = promise } }),
    }
    const tracer = { flushAll: done => done() }
    const unregister = registerVercelTelemetryRetention(tracer)

    try {
      channel('apm:http2:server:response:emit').publish({ eventName: 'close' })
      await retained
    } finally {
      unregister()
    }
  })
})
