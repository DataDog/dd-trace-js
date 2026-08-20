'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const http = require('node:http')
const path = require('node:path')
const { setImmediate: setImmediatePromise } = require('node:timers/promises')

const { describe, it, afterEach } = require('mocha')
const { logs } = require('@opentelemetry/api-logs')
const { metrics } = require('@opentelemetry/api')
const { channel } = require('dc-polyfill')
const sinon = require('sinon')

const { FakeAgent } = require('../../../integration-tests/helpers')

require('./setup/core')

const {
  getServerlessPlatformTags,
  getServerlessPlatform,
  enableGCPPubSubPushSubscription,
  initializeServerlessTelemetry,
} = require('../src/serverless')
const { registerVercelTelemetryRetention } = require('../src/serverless/vercel')
const { flushAll, registerFlusher, unregisterFlusher } = require('../src/flush')
const log = require('../src/log')
const agent = require('./plugins/agent')

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
    const fakeAgent = await new FakeAgent().start()
    const received = fakeAgent.assertMessageReceived(({ payload }) => {
      assert.deepStrictEqual(Object.fromEntries(
        Object.entries(payload[0][0].meta).filter(([name]) => name.startsWith('vercel.'))
      ), {
        'vercel.project_id': 'prj_123',
        'vercel.environment': 'preview',
        'vercel.region': 'custom-region',
      })
    })
    const child = fork(path.join(__dirname, 'fixtures', 'vercel-telemetry.js'), [], {
      env: {
        ...process.env,
        DD_TRACE_AGENT_PORT: fakeAgent.port,
        VERCEL: '1',
        VERCEL_DEPLOYMENT_ID: 'dpl_123',
        VERCEL_ENV: 'preview',
        VERCEL_PROJECT_ID: 'prj_123',
        VERCEL_REGION: 'iad1',
        VERCEL_TARGET_ENV: 'staging',
        VERCEL_TEST_SPAN_METADATA: '1',
      },
      silent: true,
    })
    const childExited = once(child, 'exit')
    try {
      await received
    } finally {
      if (child.exitCode === null) child.kill()
      await childExited
      await fakeAgent.stop()
    }
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
    const received = new Set()
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
        res.end()
      })
    })
    await new Promise(resolve => intake.listen(0, '127.0.0.1', resolve))
    const { port } = intake.address()
    const endpoint = `http://127.0.0.1:${port}`
    const child = fork(path.join(__dirname, 'fixtures', 'vercel-telemetry.js'), [], {
      env: {
        ...process.env,
        DD_LOGS_OTEL_ENABLED: 'true',
        DD_METRICS_OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${endpoint}/v1/logs`,
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${endpoint}/v1/metrics`,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${endpoint}/v1/traces`,
        OTEL_TRACES_EXPORTER: 'otlp',
        VERCEL: '1',
        VERCEL_TEST_OTEL: '1',
      },
      silent: true,
    })
    const childExited = once(child, 'exit')

    try {
      await once(child, 'message')

      const retained = once(child, 'message')
      child.send('request')
      const [retainedMessage] = await retained
      assert.deepStrictEqual(retainedMessage, { type: 'retained', value: true })

      const released = once(child, 'message')
      const [releasedMessage] = await released
      assert.deepStrictEqual(releasedMessage, { type: 'released' })
      const [code, signal] = await childExited
      assert.strictEqual(code, 0)
      assert.strictEqual(signal, null)
      assert.deepStrictEqual(received, new Set(['traces', 'logs', 'metrics']))
      assert.strictEqual(metricPayloads, 2)
    } finally {
      if (child.exitCode === null) child.kill()
      await new Promise(resolve => intake.close(resolve))
    }
  })

  it('retains instrumentation telemetry when APM tracing is disabled', async () => {
    const responses = []
    let releaseResponses = false
    let telemetryReceived
    const intakeReceived = new Promise(resolve => { telemetryReceived = resolve })
    const intake = http.createServer((request, response) => {
      request.resume()
      request.once('end', () => {
        if (releaseResponses) response.end()
        else responses.push(response)
        telemetryReceived()
      })
    })
    await new Promise(resolve => intake.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${intake.address().port}`
    const child = fork(path.join(__dirname, 'fixtures', 'vercel-telemetry.js'), [], {
      env: {
        ...process.env,
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
        DD_TRACE_AGENT_URL: endpoint,
        VERCEL: '1',
      },
      silent: true,
    })
    const childExited = once(child, 'exit')

    try {
      const ready = once(child, 'message')
      await Promise.all([intakeReceived, ready])

      const retained = once(child, 'message')
      child.send('request')
      const [retainedMessage] = await retained
      assert.deepStrictEqual(retainedMessage, { type: 'retained', value: true })

      let released = false
      child.once('message', () => { released = true })
      const releasedMessage = once(child, 'message')
      await setImmediatePromise()
      assert.strictEqual(released, false)

      releaseResponses = true
      for (const response of responses) response.end()
      const [message] = await releasedMessage
      assert.deepStrictEqual(message, { type: 'released' })
      const [code, signal] = await childExited
      assert.strictEqual(code, 0)
      assert.strictEqual(signal, null)
    } finally {
      if (child.exitCode === null) child.kill()
      for (const response of responses) response.end()
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

    const unregister = initializeServerlessTelemetry(tracer)
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
    registerFlusher('telemetry', telemetryFlusher)
    const unregister = registerVercelTelemetryRetention({ flushAll })
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
      unregisterFlusher('telemetry')
    }
  })

  it('retains telemetry again when an outer Vercel response follows a nested request', async () => {
    const retained = []
    const flushes = []
    globalThis[requestContext] = {
      get: () => ({ waitUntil: promise => { retained.push(promise) } }),
    }
    const unregister = registerVercelTelemetryRetention({
      flushAll (done) {
        flushes.push(done)
      },
    })
    try {
      channel('apm:http:server:request:finish').publish({ req: {} })
      await new Promise(resolve => setImmediate(resolve))
      channel('apm:http:server:request:finish').publish({ req: {} })
      await new Promise(resolve => setImmediate(resolve))

      // Other tracers initialized by this file can share this request context;
      // the callback count below isolates this test's tracer.
      assert.ok(retained.length >= 2)
      assert.strictEqual(flushes.length, 2)
      flushes[0]()
      flushes[1]()
    } finally {
      unregister()
    }
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

  it('logs a Vercel telemetry flush failure before releasing the invocation', async () => {
    const error = 'flush failed'
    const errorLog = sinon.stub(log, 'error')
    let retained
    globalThis[requestContext] = {
      get: () => ({ waitUntil: promise => { retained = promise } }),
    }

    const unregister = registerVercelTelemetryRetention({
      flushAll () {
        throw error
      },
    })
    try {
      channel('apm:http:server:request:finish').publish({})
      await retained

      sinon.assert.calledOnceWithExactly(errorLog, 'Failed to flush Vercel telemetry: %s', error)
    } finally {
      unregister()
      errorLog.restore()
    }
  })

  it('logs a Vercel waitUntil failure without flushing', () => {
    const error = null
    const errorLog = sinon.stub(log, 'error')
    const flushAll = sinon.spy()
    globalThis[requestContext] = {
      get: () => ({ waitUntil: () => { throw error } }),
    }

    const unregister = registerVercelTelemetryRetention({ flushAll })
    try {
      channel('apm:http:server:request:finish').publish({})

      sinon.assert.notCalled(flushAll)
      sinon.assert.calledWithExactly(errorLog, 'Failed to retain Vercel invocation: %s', error)
    } finally {
      unregister()
      errorLog.restore()
    }
  })

  it('does not flush without an active Vercel request context', () => {
    const flushAll = sinon.spy()
    globalThis[requestContext] = { get: () => undefined }

    const unregister = registerVercelTelemetryRetention({ flushAll })
    try {
      channel('apm:http:server:request:finish').publish({})

      sinon.assert.notCalled(flushAll)
    } finally {
      unregister()
    }
  })

  it('logs a Vercel request-context lookup failure without flushing', () => {
    const error = new Error('context lookup failed')
    const errorLog = sinon.stub(log, 'error')
    const flushAll = sinon.spy()
    globalThis[requestContext] = {
      get () { throw error },
    }

    const unregister = registerVercelTelemetryRetention({ flushAll })
    try {
      channel('apm:http:server:request:finish').publish({})

      sinon.assert.notCalled(flushAll)
      sinon.assert.calledOnceWithExactly(errorLog, 'Failed to access Vercel request context: %s', error)
    } finally {
      unregister()
      errorLog.restore()
    }
  })

  it('logs a Vercel waitUntil lookup failure without flushing', () => {
    const error = new Error('waitUntil lookup failed')
    const errorLog = sinon.stub(log, 'error')
    const flushAll = sinon.spy()
    globalThis[requestContext] = {
      get: () => Object.defineProperty({}, 'waitUntil', {
        get () { throw error },
      }),
    }

    const unregister = registerVercelTelemetryRetention({ flushAll })
    try {
      channel('apm:http:server:request:finish').publish({})

      sinon.assert.notCalled(flushAll)
      sinon.assert.calledOnceWithExactly(errorLog, 'Failed to access Vercel request context: %s', error)
    } finally {
      unregister()
      errorLog.restore()
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
