'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')

require('./setup/core')

const { enableGCPPubSubPushSubscription, onRequestEnd } = require('../src/serverless')

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

describe('onRequestEnd', () => {
  const requestContext = Symbol.for('@vercel/request-context')
  const originalVercel = process.env.VERCEL
  const originalContext = globalThis[requestContext]

  afterEach(() => {
    if (originalVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = originalVercel

    if (originalContext === undefined) delete globalThis[requestContext]
    else globalThis[requestContext] = originalContext
  })

  it('retains the request until all exporters flush on Vercel', async () => {
    process.env.VERCEL = '1'
    let retained
    let done
    globalThis[requestContext] = {
      get: () => ({ waitUntil: promise => { retained = promise } }),
    }

    const registered = onRequestEnd({
      _tracer: {
        flushAll: callback => { done = callback },
      },
    })

    assert.strictEqual(registered, true)
    let completed = false
    retained.then(() => { completed = true })
    await Promise.resolve()
    assert.strictEqual(completed, false)

    done()
    await retained
    assert.strictEqual(completed, true)
  })

  it('does not flush outside Vercel', () => {
    delete process.env.VERCEL
    let flushed = false

    const registered = onRequestEnd({
      _tracer: {
        flushAll: () => { flushed = true },
      },
    })

    assert.strictEqual(registered, false)
    assert.strictEqual(flushed, false)
  })
})
