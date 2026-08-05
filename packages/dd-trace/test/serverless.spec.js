'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')

require('./setup/core')

const { enableGCPPubSubPushSubscription, onRequestEnd, retainVercelRequest } = require('../src/serverless')
const { trackExport } = require('../src/serverless/pending_exports')

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
  })

  it('retains globally pending exports until they complete', async () => {
    process.env.VERCEL = '1'
    let retained
    const finishExport = trackExport()
    globalThis[requestContext] = {
      get: () => ({ waitUntil: promise => { retained = promise } }),
    }

    assert.strictEqual(onRequestEnd(), true)

    let completed = false
    retained.then(() => { completed = true })
    await Promise.resolve()
    assert.strictEqual(completed, false)

    finishExport()
    await retained
    assert.strictEqual(completed, true)
  })

  it('does nothing outside Vercel', () => {
    delete process.env.VERCEL
    assert.strictEqual(retainVercelRequest(Promise.resolve()), false)
  })
})
