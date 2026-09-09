'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const http = require('node:http')

const { describe, it, beforeEach, afterEach } = require('mocha')
const { logs } = require('@opentelemetry/api-logs')
const { metrics } = require('@opentelemetry/api')
const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('./setup/core')

const {
  enableGCPPubSubPushSubscription,
} = require('../src/serverless')
const { registerVercelTelemetryRetention } = require('../src/serverless/vercel')
const { flushServerlessTelemetry } = require('../src/flush')
const TelemetryDeliveryTracker = require('../src/serverless/telemetry-delivery-tracker')
const agent = require('./plugins/agent')
const { getConfigFresh } = require('./helpers/config')

function getServerlessFresh () {
  const loadServerless = proxyquire.noPreserveCache()
  return loadServerless('../src/serverless', {})
}

function getServerlessModulesFresh () {
  const serverless = getServerlessFresh()
  const loadFlush = proxyquire.noPreserveCache()
  const flush = loadFlush('../src/flush', {
    './serverless': serverless,
  })
  return { flush, serverless }
}

describe('TelemetryDeliveryTracker', () => {
  it('snapshots Vercel detection at module load', () => {
    const originalVercel = process.env.VERCEL
    try {
      delete process.env.VERCEL
      const nonVercelServerless = getServerlessFresh()

      process.env.VERCEL = '1'
      assert.strictEqual(nonVercelServerless.createServerlessDeliveryTracker(), undefined)
      assert.strictEqual(nonVercelServerless.supportsServerlessTelemetryRetention(), false)

      const vercelServerless = getServerlessFresh()
      delete process.env.VERCEL
      assert.ok(vercelServerless.createServerlessDeliveryTracker() instanceof TelemetryDeliveryTracker)
      assert.strictEqual(vercelServerless.supportsServerlessTelemetryRetention(), true)
    } finally {
      if (originalVercel === undefined) delete process.env.VERCEL
      else process.env.VERCEL = originalVercel
    }
  })

  it('completes immediately without active deliveries', () => {
    const tracker = new TelemetryDeliveryTracker()
    let done = 0

    tracker.waitForIdle(() => { done++ })

    assert.strictEqual(done, 1)
  })

  it('joins deliveries that were active at the retention boundary', () => {
    const tracker = new TelemetryDeliveryTracker()
    const complete = []
    let done = 0

    tracker.track(callback => complete.push(callback))
    tracker.track(callback => complete.push(callback))
    tracker.waitForIdle(() => { done++ })

    const firstCompletion = complete.shift()
    firstCompletion()
    assert.strictEqual(done, 0)
    const secondCompletion = complete.shift()
    secondCompletion()
    assert.strictEqual(done, 1)
  })

  it('does not wait for deliveries that begin after the retention boundary', () => {
    const tracker = new TelemetryDeliveryTracker()
    const complete = []
    let done = 0

    tracker.track(callback => complete.push(callback))
    tracker.waitForIdle(() => { done++ })
    tracker.track(callback => complete.push(callback))

    const firstCompletion = complete.shift()
    firstCompletion()
    assert.strictEqual(done, 1)
    const secondCompletion = complete.shift()
    secondCompletion()
    assert.strictEqual(done, 1)
  })

  it('completes a delivery only once', () => {
    const tracker = new TelemetryDeliveryTracker()
    let complete
    let done = 0

    tracker.track(callback => { complete = callback }, () => { done++ })
    complete()
    complete()

    assert.strictEqual(done, 1)
  })
})

describe('flushServerlessTelemetry', () => {
  it('completes immediately without configured pipelines', () => {
    let done = 0

    flushServerlessTelemetry(() => { done++ })

    assert.strictEqual(done, 1)
  })
})

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

    assert.deepStrictEqual(getServerlessFresh().getServerlessPlatformTags(), [
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

    assert.deepStrictEqual(getServerlessFresh().getServerlessPlatformTags(), [
      'vercel.environment', 'preview',
    ])
  })

  it('records the Vercel environment in configuration', () => {
    process.env = { ...environment, VERCEL: '1' }

    assert.strictEqual(getServerlessFresh().getServerlessPlatform().isVercel, true)
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

  beforeEach(() => {
    process.env.VERCEL = '1'
  })

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
    const responses = []
    let intakeReceived
    let metricPayloads = 0
    const intake = http.createServer((req, res) => {
      req.resume()
      req.once('end', () => {
        if (req.url === '/v1/logs') received.add('logs')
        if (req.url === '/v1/metrics') {
          received.add('metrics')
          metricPayloads++
        }
        if (req.url === '/v1/traces') received.add('traces')
        responses.push(res)
        if (received.size === 3 && metricPayloads === 2) intakeReceived()
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

    let unregister
    try {
      const { flush, serverless } = getServerlessModulesFresh()
      const loadTracer = proxyquire.noPreserveCache()
      const Tracer = loadTracer('../src/tracer', {
        './flush': flush,
        './serverless': serverless,
      })
      const loadOpenTelemetryLogs = proxyquire.noPreserveCache()
      const { initializeOpenTelemetryLogs } = loadOpenTelemetryLogs('../src/opentelemetry/logs', {
        '../../flush': flush,
      })
      const loadOpenTelemetryMetrics = proxyquire.noPreserveCache()
      const { initializeOpenTelemetryMetrics } = loadOpenTelemetryMetrics('../src/opentelemetry/metrics', {
        '../../flush': flush,
      })
      const config = getConfigFresh({ service: 'serverless-flush' }, { '../serverless': serverless })
      const tracer = new Tracer(config)
      initializeOpenTelemetryLogs(config)
      initializeOpenTelemetryMetrics(config)

      tracer.trace('serverless.flush', {}, () => {})
      logs.getLogger('serverless-flush').emit({ body: 'flush me' })
      metrics.getMeter('serverless-flush').createCounter('flush.me').add(1)

      unregister = registerVercelTelemetryRetention(tracer)
      channel('apm:http:server:request:finish').publish({})
      await intakeRequests

      let settled = false
      retained.then(() => { settled = true })
      await new Promise(resolve => setImmediate(resolve))
      assert.strictEqual(settled, false)

      for (const response of responses) response.end()
      await retained
      assert.deepStrictEqual(received, new Set(['traces', 'logs', 'metrics']))
      assert.strictEqual(metricPayloads, 2)
    } finally {
      for (const response of responses) response.end()
      unregister?.()
      metrics.getMeterProvider()?.reader?.shutdown()
      logs.getLoggerProvider()?.shutdown?.()
      await new Promise(resolve => intake.close(resolve))
    }
  })

  it('waits for HTTP response completion after Next request finish', async () => {
    process.env.VERCEL = '1'
    let retained
    globalThis[requestContext] = {
      get: () => ({ waitUntil: promise => { retained = promise } }),
    }
    const nextFinishChannel = channel('apm:next:request:finish')
    const httpFinishChannel = channel('apm:http:server:request:finish')
    let finished = false
    const tracer = {
      flushAll (done) {
        assert.ok(finished)
        done()
      },
    }

    const unregister = getServerlessFresh().initializeServerlessTelemetry(tracer)
    try {
      nextFinishChannel.publish({})
      assert.strictEqual(retained, undefined)
      finished = true
      httpFinishChannel.publish({})
      await retained
    } finally {
      unregister()
    }
  })

  it('retains telemetry for an ordinary HTTP Vercel request only once', async () => {
    const retained = []
    let flushes = 0
    const context = { waitUntil: promise => { retained.push(promise) } }
    globalThis[requestContext] = { get: () => context }

    const unregister = registerVercelTelemetryRetention({
      flushAll (done) {
        flushes++
        done()
      },
    })
    try {
      channel('apm:http:server:request:finish').publish({})
      await Promise.all(retained)
      assert.strictEqual(flushes, 1)
    } finally {
      unregister()
    }
  })

  it('skips retention without a Vercel waitUntil boundary', async () => {
    let flushes = 0
    const unregister = registerVercelTelemetryRetention({
      flushAll () {
        flushes++
      },
    })
    try {
      delete globalThis[requestContext]
      channel('apm:http:server:request:finish').publish({})
      globalThis[requestContext] = { get: () => ({}) }
      channel('apm:http:server:request:finish').publish({})
      await new Promise(resolve => setImmediate(resolve))

      assert.strictEqual(flushes, 0)
    } finally {
      unregister()
    }
  })

  it('retains an instrumented HTTP request without HTTP tracing plugins', () => {
    const vercelModule = require.resolve('../src/serverless/vercel')
    const instrumentationRegister = require.resolve('../../datadog-instrumentations/src/helpers/register')
    const script = `
      process.env.VERCEL = '1'
      process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'
      const { registerVercelTelemetryRetention } = require(${JSON.stringify(vercelModule)})
      require(${JSON.stringify(instrumentationRegister)})
      const http = require('node:http')
      const requestContext = Symbol.for('@vercel/request-context')
      let retained
      let flushes = 0
      globalThis[requestContext] = { get: () => ({ waitUntil: promise => { retained = promise } }) }
      const unregister = registerVercelTelemetryRetention({ flushAll: done => { flushes++; done() } })
      const server = http.createServer((_req, res) => res.end())
      const fail = error => {
        unregister()
        server.close(() => { throw error })
      }
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        http.get('http://127.0.0.1:' + port, res => {
          res.resume()
          res.once('end', () => {
            setTimeout(() => {
              if (!retained) return fail(new Error('Vercel retention was not registered'))
              retained.then(() => {
                if (flushes !== 1) return fail(new Error('Vercel telemetry was not flushed'))
                unregister()
                server.close()
              })
            }, 0)
          })
        }).on('error', fail)
      })
    `
    const result = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 5_000 })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('retains an instrumented HTTP/2 request without HTTP tracing plugins', () => {
    const vercelModule = require.resolve('../src/serverless/vercel')
    const instrumentationRegister = require.resolve('../../datadog-instrumentations/src/helpers/register')
    const script = `
      process.env.VERCEL = '1'
      process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'
      const { registerVercelTelemetryRetention } = require(${JSON.stringify(vercelModule)})
      require(${JSON.stringify(instrumentationRegister)})
      const http2 = require('node:http2')
      const requestContext = Symbol.for('@vercel/request-context')
      let retained
      let flushes = 0
      globalThis[requestContext] = { get: () => ({ waitUntil: promise => { retained = promise } }) }
      const unregister = registerVercelTelemetryRetention({ flushAll: done => { flushes++; done() } })
      const server = http2.createServer()
      const fail = error => {
        unregister()
        server.close(() => { throw error })
      }
      server.on('stream', stream => {
        stream.respond({ ':status': 200 })
        stream.end()
      })
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        const client = http2.connect('http://127.0.0.1:' + port)
        const request = client.request()
        request.resume()
        request.once('end', () => {
          client.close()
          setTimeout(() => {
            if (!retained) return fail(new Error('Vercel retention was not registered'))
            retained.then(() => {
              if (flushes !== 1) return fail(new Error('Vercel telemetry was not flushed'))
              unregister()
              server.close()
            })
          }, 0)
        })
        request.end()
      })
    `
    const result = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 5_000 })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('logs a Vercel waitUntil registration failure and still flushes', async () => {
    const error = new Error('request context closed')
    const warn = sinon.stub(require('../src/log'), 'warn')
    globalThis[requestContext] = { get: () => ({ waitUntil: () => { throw error } }) }
    const flushAll = sinon.spy(done => done())
    const unregister = registerVercelTelemetryRetention({ flushAll })

    try {
      channel('apm:http:server:request:finish').publish({})
      await new Promise(resolve => setImmediate(resolve))
      sinon.assert.calledWith(warn, 'Unable to retain Vercel telemetry:', error)
      sinon.assert.calledOnce(flushAll)
    } finally {
      unregister()
      warn.restore()
    }
  })

  it('retains a configured telemetry-only pipeline without a trace exporter', async () => {
    let retained
    const completeTelemetry = []
    let flushes = 0
    globalThis[requestContext] = {
      get: () => ({ waitUntil: promise => { retained = promise } }),
    }
    const telemetryFlusher = done => {
      flushes++
      completeTelemetry.push(done)
    }
    const { flush } = getServerlessModulesFresh()
    const unregisterTelemetry = flush.registerTelemetryFlusher(telemetryFlusher)
    const unregister = registerVercelTelemetryRetention({
      flushAll: (done, options) => flush.flushServerlessTelemetry(done, options),
    })
    try {
      channel('apm:http:server:request:finish').publish({})
      await new Promise(resolve => setImmediate(resolve))

      assert.ok(flushes >= 1)
      assert.ok(completeTelemetry.every(done => typeof done === 'function'))
      let settled = false
      retained.then(() => { settled = true })
      await new Promise(resolve => setImmediate(resolve))
      assert.strictEqual(settled, false)

      for (const done of completeTelemetry) done()
      await retained
    } finally {
      unregister()
      unregisterTelemetry()
    }
  })

  it('coalesces overlapping Vercel responses into one queued flush', () => {
    const fixture = require.resolve('./fixtures/vercel-telemetry-coalescing')
    const result = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 5_000 })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('passes Vercel retention timeout to the telemetry flush barrier', async () => {
    let retained
    let options
    globalThis[requestContext] = {
      get: () => ({ waitUntil: promise => { retained = promise } }),
    }

    let unregister
    try {
      unregister = registerVercelTelemetryRetention({
        flushAll (done, flushOptions) {
          options = flushOptions
          done()
        },
      })
      channel('apm:http:server:request:finish').publish({})
      await retained

      assert.deepStrictEqual(options, { timeout: 2_000 })
    } finally {
      unregister?.()
    }
  })

  it('retains telemetry at HTTP/2 response completion', async () => {
    let retained
    globalThis[requestContext] = {
      get: () => ({ waitUntil: promise => { retained = promise } }),
    }

    let flushes = 0
    const unregister = registerVercelTelemetryRetention({
      flushAll (done) {
        flushes++
        done()
      },
    })
    try {
      channel('apm:http2:server:response:emit').publish({ eventName: 'finish' })
      assert.strictEqual(retained, undefined)
      channel('apm:http2:server:response:emit').publish({ eventName: 'close' })
      await retained
      assert.strictEqual(flushes, 1)
    } finally {
      unregister()
    }
  })
})
