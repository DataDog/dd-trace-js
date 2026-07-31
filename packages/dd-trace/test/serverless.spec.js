'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')
const { metrics } = require('@opentelemetry/api')
const { logs } = require('@opentelemetry/api-logs')

require('./setup/core')

const { enableGCPPubSubPushSubscription, scheduleVercelFlush } = require('../src/serverless')

const nextRequestContext = Symbol.for('@next/request-context')
const vercelRequestContext = Symbol.for('@vercel/request-context')

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

describe('Vercel request-lifetime native OTLP flush', () => {
  const originalVercel = process.env.VERCEL

  afterEach(() => {
    if (originalVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = originalVercel
    delete globalThis[nextRequestContext]
    delete globalThis[vercelRequestContext]
    metrics.disable()
    logs.disable()
  })

  it('registers before deferring native OTLP export and retains it until completion', async () => {
    process.env.VERCEL = '1'
    let done
    let requestTask
    let requestTaskResolved = false
    let waitUntilCalled = false
    globalThis[vercelRequestContext] = {
      get: () => ({
        waitUntil: promise => {
          waitUntilCalled = true
          requestTask = promise
        },
      }),
    }

    assert.strictEqual(scheduleVercelFlush(createNativeOtlpTracer(callback => {
      assert.strictEqual(waitUntilCalled, true)
      done = callback
    })), true)
    assert.strictEqual(waitUntilCalled, true)
    assert.strictEqual(done, undefined)

    requestTask.then(() => { requestTaskResolved = true })
    await nextImmediate()
    assert.strictEqual(typeof done, 'function')
    assert.strictEqual(requestTaskResolved, false)

    done()
    await requestTask
    assert.strictEqual(requestTaskResolved, true)
  })

  it('retains OTLP logs until their exporter completes', async () => {
    process.env.VERCEL = '1'
    let requestTask
    let finishLogExport
    const loggerProvider = {
      getLogger () {},
      forceFlush () {
        return new Promise(resolve => { finishLogExport = resolve })
      },
    }
    logs.setGlobalLoggerProvider(loggerProvider)
    globalThis[vercelRequestContext] = {
      get: () => ({ waitUntil: promise => { requestTask = promise } }),
    }

    assert.strictEqual(scheduleVercelFlush({
      _config: {
        DD_LOGS_OTEL_ENABLED: true,
        OTEL_TRACES_EXPORTER: 'none',
      },
    }), true)
    await nextImmediate()

    let requestCompleted = false
    requestTask.then(() => { requestCompleted = true })
    await Promise.resolve()
    assert.strictEqual(requestCompleted, false)
    finishLogExport()
    await requestTask
    assert.strictEqual(requestCompleted, true)
  })

  it('retains OTLP metrics until their exporter completes', async () => {
    process.env.VERCEL = '1'
    let requestTask
    let finishMetricExport
    metrics.setGlobalMeterProvider({
      getMeter () {},
      reader: {
        forceFlush () {
          return new Promise(resolve => { finishMetricExport = resolve })
        },
      },
    })
    globalThis[vercelRequestContext] = {
      get: () => ({ waitUntil: promise => { requestTask = promise } }),
    }

    assert.strictEqual(scheduleVercelFlush({
      _config: {
        DD_METRICS_OTEL_ENABLED: true,
        OTEL_TRACES_EXPORTER: 'none',
      },
    }), true)
    await nextImmediate()

    let requestCompleted = false
    requestTask.then(() => { requestCompleted = true })
    await Promise.resolve()
    assert.strictEqual(requestCompleted, false)
    finishMetricExport()
    await requestTask
    assert.strictEqual(requestCompleted, true)
  })

  it('does not schedule outside Vercel or for non-OTLP exporters', () => {
    let waitUntilCalls = 0
    globalThis[vercelRequestContext] = {
      get: () => ({ waitUntil: () => { waitUntilCalls++ } }),
    }

    assert.strictEqual(scheduleVercelFlush(createNativeOtlpTracer(assert.fail)), false)
    process.env.VERCEL = '1'
    assert.strictEqual(scheduleVercelFlush({
      _config: { OTEL_TRACES_EXPORTER: 'none' },
      _exporter: { flush: assert.fail },
    }), false)
    assert.strictEqual(waitUntilCalls, 0)
  })
})

function createNativeOtlpTracer (flush) {
  return {
    _config: { OTEL_TRACES_EXPORTER: 'otlp' },
    _exporter: { flush },
  }
}

function nextImmediate () {
  return new Promise(resolve => setImmediate(resolve))
}
