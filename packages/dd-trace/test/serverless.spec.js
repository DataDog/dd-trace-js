'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const http = require('node:http')

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

describe('Vercel request-lifetime flush', () => {
  const originalVercel = process.env.VERCEL

  afterEach(() => {
    if (originalVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = originalVercel
    delete globalThis[nextRequestContext]
    delete globalThis[vercelRequestContext]
  })

  for (const requestContext of [nextRequestContext, vercelRequestContext]) {
    it(`uses ${requestContext.description} and completes after the request`, async () => {
      process.env.VERCEL = '1'
      let done
      let requestTask
      globalThis[requestContext] = createRequestContext(promise => { requestTask = promise })

      assert.strictEqual(scheduleVercelFlush(createAgentlessTracer(callback => { done = callback })), true)
      await nextImmediate()
      assert.strictEqual(typeof done, 'function')
      done()
      await requestTask
    })
  }

  it('retains a loopback export until its intake response completes', async () => {
    process.env.VERCEL = '1'
    const requestContextStorage = new AsyncLocalStorage()
    let requestTask
    let releaseResponse
    let exported = false
    let requestStarted
    const intakeRequest = new Promise(resolve => { requestStarted = resolve })
    const intake = http.createServer((request, response) => {
      requestStarted()
      releaseResponse = () => response.end('accepted')
    })
    await listen(intake)
    globalThis[vercelRequestContext] = { get: () => requestContextStorage.getStore() }

    try {
      requestContextStorage.run({ waitUntil: promise => { requestTask = promise } }, () => {
        assert.strictEqual(scheduleVercelFlush(createAgentlessTracer(done => {
          const request = http.request({
            hostname: '127.0.0.1',
            port: intake.address().port,
            method: 'POST',
          }, response => {
            response.resume()
            response.once('end', () => {
              exported = true
              done()
            })
          })
          request.end('trace payload')
        })), true)
      })

      await intakeRequest
      assert.strictEqual(exported, false)
      releaseResponse()
      await requestTask
      assert.strictEqual(exported, true)
    } finally {
      await close(intake)
    }
  })

  it('does not schedule outside Vercel or for non-agentless exporters', () => {
    let waitUntilCalls = 0
    globalThis[vercelRequestContext] = createRequestContext(() => { waitUntilCalls++ })
    assert.strictEqual(scheduleVercelFlush(createAgentlessTracer(assert.fail)), false)
    process.env.VERCEL = '1'
    const agentTracer = {
      _config: { experimental: { exporter: 'agent' } },
      _exporter: { flush: assert.fail },
    }
    assert.strictEqual(scheduleVercelFlush(agentTracer), false)
    assert.strictEqual(waitUntilCalls, 0)
  })

  it('falls back when request context access throws', async () => {
    process.env.VERCEL = '1'
    let done
    let requestTask
    globalThis[nextRequestContext] = { get: () => { throw new Error('not available') } }
    globalThis[vercelRequestContext] = createRequestContext(promise => { requestTask = promise })
    assert.strictEqual(scheduleVercelFlush(createAgentlessTracer(callback => { done = callback })), true)
    await nextImmediate()
    done()
    await requestTask
  })

  it('does not flush when waitUntil throws', async () => {
    process.env.VERCEL = '1'
    let flushes = 0
    globalThis[vercelRequestContext] = createRequestContext(() => { throw new Error('request complete') })
    assert.strictEqual(scheduleVercelFlush(createAgentlessTracer(() => { flushes++ })), false)
    await nextImmediate()
    assert.strictEqual(flushes, 0)
  })

  it('settles the request task when the exporter flush throws', async () => {
    process.env.VERCEL = '1'
    let requestTask
    globalThis[vercelRequestContext] = createRequestContext(promise => { requestTask = promise })
    assert.strictEqual(scheduleVercelFlush(createAgentlessTracer(() => { throw new Error('export failed') })), true)
    await requestTask
  })
})

function createAgentlessTracer (flush) {
  return { _config: { experimental: { exporter: 'agentless' } }, _exporter: { flush } }
}

function createRequestContext (waitUntil) {
  return { get: () => ({ waitUntil }) }
}

function nextImmediate () {
  return new Promise(resolve => setImmediate(resolve))
}

function listen (server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
}

function close (server) {
  return new Promise(resolve => server.close(resolve))
}
