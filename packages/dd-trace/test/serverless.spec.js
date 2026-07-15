'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const http = require('node:http')

const { describe, it, afterEach } = require('mocha')

require('./setup/core')

const {
  enableGCPPubSubPushSubscription,
  scheduleVercelFlush,
} = require('../src/serverless')

const nextRequestContext = Symbol.for('@next/request-context')

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

describe('scheduleVercelFlush', () => {
  const originalVercel = process.env.VERCEL

  afterEach(() => {
    if (originalVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = originalVercel
    delete globalThis[nextRequestContext]
  })

  it('keeps the request alive until asynchronous export completes', async () => {
    process.env.VERCEL = '1'
    let flushDone
    let waitUntilTask
    let settled = false
    const tracer = createAgentlessTracer(done => {
      flushDone = done
    })
    globalThis[nextRequestContext] = createRequestContext(promise => {
      waitUntilTask = promise
      promise.then(() => {
        settled = true
      })
    })

    assert.strictEqual(scheduleVercelFlush(tracer), true)
    assert.ok(waitUntilTask instanceof Promise)

    await nextImmediate()

    assert.strictEqual(typeof flushDone, 'function')
    assert.strictEqual(settled, false)

    flushDone()
    await waitUntilTask

    assert.strictEqual(settled, true)
  })

  it('keeps a serverless invocation alive through a loopback intake request', async () => {
    process.env.VERCEL = '1'
    const requestContextStorage = new AsyncLocalStorage()
    const waitUntilTasks = []
    let intakeRequestStarted
    let releaseIntakeResponse
    let exported = false
    const intakeRequest = new Promise(resolve => {
      intakeRequestStarted = resolve
    })
    const intake = http.createServer((req, res) => {
      intakeRequestStarted()
      releaseIntakeResponse = () => res.end('accepted')
    })

    await listen(intake)

    const tracer = createAgentlessTracer(done => {
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
    })
    globalThis[nextRequestContext] = {
      get: () => requestContextStorage.getStore(),
    }

    try {
      let responseComplete = false
      requestContextStorage.run({
        waitUntil: promise => waitUntilTasks.push(promise),
      }, () => {
        assert.strictEqual(scheduleVercelFlush(tracer), true)
        responseComplete = true
      })

      assert.strictEqual(responseComplete, true)
      assert.strictEqual(exported, false)
      assert.strictEqual(waitUntilTasks.length, 1)

      await intakeRequest

      assert.strictEqual(exported, false)
      releaseIntakeResponse()
      await waitUntilTasks[0]

      assert.strictEqual(exported, true)
    } finally {
      await close(intake)
    }
  })

  it('tracks concurrent request flushes independently', async () => {
    process.env.VERCEL = '1'
    const flushCallbacks = []
    const waitUntilTasks = []
    const tracer = createAgentlessTracer(done => {
      flushCallbacks.push(done)
    })
    globalThis[nextRequestContext] = createRequestContext(promise => {
      waitUntilTasks.push(promise)
    })

    assert.strictEqual(scheduleVercelFlush(tracer), true)
    assert.strictEqual(scheduleVercelFlush(tracer), true)

    await nextImmediate()

    assert.strictEqual(flushCallbacks.length, 2)
    assert.strictEqual(waitUntilTasks.length, 2)
    assert.notStrictEqual(waitUntilTasks[0], waitUntilTasks[1])

    flushCallbacks[1]()
    await waitUntilTasks[1]

    let firstSettled = false
    waitUntilTasks[0].then(() => {
      firstSettled = true
    })
    await Promise.resolve()
    assert.strictEqual(firstSettled, false)

    flushCallbacks[0]()
    await waitUntilTasks[0]
    assert.strictEqual(firstSettled, true)
  })

  it('settles request-lifetime work when flush throws synchronously', async () => {
    process.env.VERCEL = '1'
    let waitUntilTask
    const tracer = createAgentlessTracer(() => {
      throw new Error('flush failed')
    })
    globalThis[nextRequestContext] = createRequestContext(promise => {
      waitUntilTask = promise
    })

    assert.strictEqual(scheduleVercelFlush(tracer), true)
    await waitUntilTask
  })

  it('settles request-lifetime work after an asynchronous export error', async () => {
    process.env.VERCEL = '1'
    let waitUntilTask
    const tracer = createAgentlessTracer(done => {
      setImmediate(done, new Error('intake failed'))
    })
    globalThis[nextRequestContext] = createRequestContext(promise => {
      waitUntilTask = promise
    })

    assert.strictEqual(scheduleVercelFlush(tracer), true)
    await waitUntilTask
  })

  it('does not schedule outside Vercel', async () => {
    let flushes = 0
    let waitUntilCalls = 0
    const tracer = createAgentlessTracer(() => {
      flushes++
    })
    globalThis[nextRequestContext] = createRequestContext(() => {
      waitUntilCalls++
    })

    assert.strictEqual(scheduleVercelFlush(tracer), false)
    await nextImmediate()

    assert.strictEqual(flushes, 0)
    assert.strictEqual(waitUntilCalls, 0)
  })

  it('does not schedule for the normal agent exporter', async () => {
    process.env.VERCEL = '1'
    let waitUntilCalls = 0
    const tracer = {
      _config: { experimental: { exporter: 'agent' } },
      _exporter: { flush: assert.fail },
    }
    globalThis[nextRequestContext] = createRequestContext(() => {
      waitUntilCalls++
    })

    assert.strictEqual(scheduleVercelFlush(tracer), false)
    await nextImmediate()

    assert.strictEqual(waitUntilCalls, 0)
  })

  it('does not schedule without an active Next request context', () => {
    process.env.VERCEL = '1'

    assert.strictEqual(scheduleVercelFlush(createAgentlessTracer(assert.fail)), false)
  })

  it('does not schedule when the Next request context cannot be read', () => {
    process.env.VERCEL = '1'
    globalThis[nextRequestContext] = {
      get: () => {
        throw new Error('request context unavailable')
      },
    }

    assert.strictEqual(scheduleVercelFlush(createAgentlessTracer(assert.fail)), false)
  })

  it('settles its task when waitUntil rejects registration', async () => {
    process.env.VERCEL = '1'
    let flushes = 0
    globalThis[nextRequestContext] = createRequestContext(() => {
      throw new Error('request already completed')
    })

    const scheduled = scheduleVercelFlush(createAgentlessTracer(() => {
      flushes++
    }))

    assert.strictEqual(scheduled, false)
    await nextImmediate()
    assert.strictEqual(flushes, 0)
  })
})

function createAgentlessTracer (flush) {
  return {
    _config: { experimental: { exporter: 'agentless' } },
    _exporter: { flush },
  }
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
