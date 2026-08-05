'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')
const { metrics } = require('@opentelemetry/api')
const { logs } = require('@opentelemetry/api-logs')

require('./setup/core')

const { enableGCPPubSubPushSubscription, onRequestEnd, retainVercelRequest } = require('../src/serverless')

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

describe('retainVercelRequest', () => {
  const requestContext = Symbol.for('@vercel/request-context')
  const originalVercel = process.env.VERCEL
  const originalRequestContext = globalThis[requestContext]

  afterEach(() => {
    if (originalVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = originalVercel

    if (originalRequestContext === undefined) delete globalThis[requestContext]
    else globalThis[requestContext] = originalRequestContext
    metrics.disable()
    logs.disable()
  })

  it('retains a promise in the active Vercel request context', () => {
    const promise = Promise.resolve()
    let retained
    process.env.VERCEL = '1'
    globalThis[requestContext] = {
      get: () => ({ waitUntil: value => { retained = value } }),
    }

    assert.strictEqual(retainVercelRequest(promise), true)
    assert.strictEqual(retained, promise)
  })

  it('does nothing outside Vercel', () => {
    delete process.env.VERCEL

    assert.strictEqual(retainVercelRequest(Promise.resolve()), false)
  })

  it('retains trace, log, and metric flushes until they complete', async () => {
    process.env.VERCEL = '1'
    let retained
    const resolvers = []
    const pendingFlush = () => new Promise(resolve => resolvers.push(resolve))
    globalThis[requestContext] = {
      get: () => ({ waitUntil: promise => { retained = promise } }),
    }
    logs.setGlobalLoggerProvider({
      getLogger () {},
      forceFlush: pendingFlush,
    })
    metrics.setGlobalMeterProvider({
      getMeter () {},
      reader: { forceFlush: pendingFlush },
    })

    assert.strictEqual(onRequestEnd({
      _config: {
        DD_LOGS_OTEL_ENABLED: true,
        DD_METRICS_OTEL_ENABLED: true,
        OTEL_TRACES_EXPORTER: 'otlp',
      },
      _exporter: { forceFlush: pendingFlush },
    }), true)
    assert.strictEqual(resolvers.length, 3)

    let completed = false
    retained.then(() => { completed = true })
    for (const resolve of resolvers.slice(0, -1)) resolve()
    await Promise.resolve()
    assert.strictEqual(completed, false)
    resolvers.at(-1)()
    await retained
    assert.strictEqual(completed, true)
  })
})
