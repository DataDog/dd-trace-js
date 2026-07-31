'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')

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
  })

  it('retains native OTLP export until its callback completes', async () => {
    process.env.VERCEL = '1'
    let done
    let requestTask
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
    assert.strictEqual(typeof done, 'function')
    done()
    await requestTask
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
