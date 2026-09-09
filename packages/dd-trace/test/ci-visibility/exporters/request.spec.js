'use strict'

const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

const commonRetry = require('../../../src/exporters/common/retry')

describe('Test Optimization exporter request', () => {
  let clock
  let commonRequest
  let pendingRequests
  let request

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: 10_000 })
    pendingRequests = []
    commonRequest = (data, options, callback) => {
      pendingRequests.push({ data, options, callback })
    }
    commonRequest.writable = true
    request = proxyquire('../../../src/ci-visibility/exporters/request', {
      '../../exporters/common/request': commonRequest,
      '../../exporters/common/retry': {
        ...commonRetry,
        getMaxAttempts: () => 2,
        getRetryDelay: () => 6000,
      },
    })
  })

  afterEach(() => {
    clock.restore()
  })

  it('lets the transport process a ready response before aborting on timeout', () => {
    const done = sinon.spy()
    request('payload', {}, done)

    assert.strictEqual(pendingRequests[0].options.deferTimeoutAbort, true)
    pendingRequests[0].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  it('retries a 5xx response within the finalization deadline', () => {
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 10_000 }, done)

    const error = Object.assign(new Error('unavailable'), { status: 503 })
    pendingRequests[0].callback(error, null, 503, {})
    clock.tick(5999)
    assert.strictEqual(pendingRequests.length, 1)
    clock.tick(1)
    assert.strictEqual(pendingRequests.length, 2)

    pendingRequests[1].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  it('keeps retrying retriable responses while the finalization deadline has capacity', () => {
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 30_000 }, done)
    const error = Object.assign(new Error('unavailable'), { status: 503 })

    pendingRequests[0].callback(error, null, 503, {})
    clock.tick(6000)
    pendingRequests[1].callback(error, null, 503, {})
    clock.tick(6000)
    pendingRequests[2].callback(error, null, 503, {})
    clock.tick(6000)
    pendingRequests[3].callback(null, 'ok', 200, {})

    assert.strictEqual(pendingRequests.length, 4)
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  it('keeps the ordinary attempt cap when deadline retries are disabled', () => {
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 30_000, retryUntilDeadline: false }, done)
    const error = Object.assign(new Error('unavailable'), { status: 503 })

    pendingRequests[0].callback(error, null, 503, {})
    clock.tick(6000)
    pendingRequests[1].callback(error, null, 503, {})
    clock.tick(6000)

    assert.strictEqual(pendingRequests.length, 2)
    sinon.assert.calledOnceWithExactly(done, error, null, 503, {})
  })

  it('allows one more attempt when an overlapping final flush extends the deadline', () => {
    const done = sinon.spy()
    const options = { deadline: Date.now() + 1000, timeout: 2000 }
    request('payload', options, done)
    const error = Object.assign(new Error('unavailable'), { code: 'ETIMEDOUT' })

    pendingRequests[0].callback(error)
    clock.tick(500)
    options.deadline = Date.now() + 2000
    pendingRequests[1].callback(error)
    clock.tick(1000)

    assert.strictEqual(pendingRequests.length, 3)
    pendingRequests[2].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  it('allows one more attempt when a final flush adopts a background request', () => {
    const done = sinon.spy()
    const options = { timeout: 2000 }
    request('payload', options, done)
    const error = Object.assign(new Error('unavailable'), { code: 'ETIMEDOUT' })

    pendingRequests[0].callback(error)
    clock.tick(6000)
    options.deadline = Date.now() + 2000
    pendingRequests[1].callback(error)
    clock.tick(1000)

    assert.strictEqual(pendingRequests.length, 3)
    pendingRequests[2].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  for (const statusCode of [408, 429, 500, 599]) {
    it(`retries a ${statusCode} response during a background flush`, () => {
      const done = sinon.spy()
      request('payload', {}, done)
      const error = Object.assign(new Error('transient response'), { status: statusCode })

      pendingRequests[0].callback(error, null, statusCode, {})
      clock.tick(5999)
      assert.strictEqual(pendingRequests.length, 1)
      clock.tick(1)
      assert.strictEqual(pendingRequests.length, 2)

      pendingRequests[1].callback(null, 'ok', 200, {})
      sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
    })
  }

  for (const statusCode of [409, 430, 499, 600]) {
    it(`does not retry a ${statusCode} response`, () => {
      const done = sinon.spy()
      request('payload', {}, done)
      const error = Object.assign(new Error('non-retriable response'), { status: statusCode })

      pendingRequests[0].callback(error, null, statusCode, {})

      assert.strictEqual(pendingRequests.length, 1)
      sinon.assert.calledOnceWithExactly(done, error, null, statusCode, {})
    })
  }

  it('keeps the ordinary attempt cap for background HTTP retries', () => {
    const done = sinon.spy()
    request('payload', {}, done)
    const error = Object.assign(new Error('unavailable'), { status: 503 })

    pendingRequests[0].callback(error, null, 503, {})
    clock.tick(6000)
    pendingRequests[1].callback(error, null, 503, {})
    clock.tick(6000)

    assert.strictEqual(pendingRequests.length, 2)
    sinon.assert.calledOnceWithExactly(done, error, null, 503, {})
  })

  it('creates a fresh readable body for every retry attempt', () => {
    const streams = []
    const createBody = () => {
      const body = Readable.from('payload')
      streams.push(body)
      return body
    }
    const done = sinon.spy()
    request(createBody, { deadline: Date.now() + 10_000 }, done)

    assert.strictEqual(pendingRequests[0].data, streams[0])
    const error = Object.assign(new Error('unavailable'), { status: 503 })
    pendingRequests[0].callback(error, null, 503, {})
    clock.tick(6000)

    assert.strictEqual(streams.length, 2)
    assert.notStrictEqual(streams[0], streams[1])
    assert.strictEqual(pendingRequests[1].data, streams[1])
    pendingRequests[1].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  it('uses a caller-provided transport', () => {
    const transport = sinon.spy((_data, _options, callback) => callback(null, 'ok', 200, {}))
    transport.writable = true
    const done = sinon.spy()

    request('payload', { transport }, done)

    sinon.assert.calledOnce(transport)
    assert.strictEqual(transport.firstCall.args[1].transport, undefined)
    assert.strictEqual(pendingRequests.length, 0)
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  it('uses the remaining finalization budget for a late 5xx retry', () => {
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 1000, timeout: 2000 }, done)

    const error = Object.assign(new Error('unavailable'), { status: 503 })
    pendingRequests[0].callback(error, null, 503, {})
    clock.tick(499)
    assert.strictEqual(pendingRequests.length, 1)
    clock.tick(1)

    assert.strictEqual(pendingRequests.length, 2)
    assert.strictEqual(pendingRequests[1].options.timeout, 500)
    pendingRequests[1].callback(null, 'ok', 200, {})
    sinon.assert.calledOnce(done)
  })

  it('uses the remaining finalization budget for a late network retry', () => {
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 1000, timeout: 2000 }, done)

    const error = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    pendingRequests[0].callback(error)
    clock.tick(500)

    assert.strictEqual(pendingRequests.length, 2)
    assert.strictEqual(pendingRequests[1].options.timeout, 500)
    pendingRequests[1].callback(null, 'ok', 200, {})
    sinon.assert.calledOnce(done)
  })

  it('waits for a rate-limit reset inside the finalization deadline', () => {
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 10_000 }, done)

    const error = Object.assign(new Error('rate limited'), { status: 429 })
    pendingRequests[0].callback(error, null, 429, { 'x-ratelimit-reset': '5' })
    clock.tick(4999)
    assert.strictEqual(pendingRequests.length, 1)
    clock.tick(1)
    assert.strictEqual(pendingRequests.length, 2)

    pendingRequests[1].callback(null, 'ok', 200, {})
    sinon.assert.calledOnce(done)
  })

  it('does not retry a rate-limit reset at the finalization deadline', () => {
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 5000 }, done)

    const error = Object.assign(new Error('rate limited'), { status: 429 })
    pendingRequests[0].callback(error, null, 429, { 'x-ratelimit-reset': '5' })

    assert.strictEqual(pendingRequests.length, 1)
    sinon.assert.calledOnceWithExactly(done, error, null, 429, { 'x-ratelimit-reset': '5' })
  })

  it('waits for a rate-limit reset during a background flush', () => {
    const done = sinon.spy()
    request('payload', {}, done)

    const error = Object.assign(new Error('rate limited'), { status: 429 })
    pendingRequests[0].callback(error, null, 429, { 'x-ratelimit-reset': '5' })
    clock.tick(4999)
    assert.strictEqual(pendingRequests.length, 1)
    clock.tick(1)
    assert.strictEqual(pendingRequests.length, 2)

    pendingRequests[1].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  it('does not exceed the rate-limit wait cap during a background flush', () => {
    const done = sinon.spy()
    request('payload', {}, done)

    const error = Object.assign(new Error('rate limited'), { status: 429 })
    pendingRequests[0].callback(error, null, 429, { 'x-ratelimit-reset': '31' })

    assert.strictEqual(pendingRequests.length, 1)
    sinon.assert.calledOnceWithExactly(done, error, null, 429, { 'x-ratelimit-reset': '31' })
  })

  it('uses a rate-limit reset over the background cap when the finalization deadline allows it', () => {
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 45_000 }, done)

    const error = Object.assign(new Error('rate limited'), { status: 429 })
    pendingRequests[0].callback(error, null, 429, { 'x-ratelimit-reset': '31' })
    clock.tick(30_999)
    assert.strictEqual(pendingRequests.length, 1)
    clock.tick(1)
    assert.strictEqual(pendingRequests.length, 2)

    pendingRequests[1].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  it('preserves ordinary background retry scheduling without a deadline', () => {
    request('payload', {}, sinon.spy())

    const error = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    pendingRequests[0].callback(error)
    clock.tick(5999)
    assert.strictEqual(pendingRequests.length, 1)
    clock.tick(1)
    assert.strictEqual(pendingRequests.length, 2)
  })

  for (const [description, options, expectedHasRef] of [
    ['detaches background retry timers by default', {}, false],
    ['keeps an owned retry alive', { keepProcessAlive: true }, true],
  ]) {
    it(description, () => {
      const setTimeoutSpy = sinon.spy(global, 'setTimeout')
      try {
        request('payload', options, sinon.spy())

        const error = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
        pendingRequests[0].callback(error)

        const retryTimer = setTimeoutSpy.lastCall.returnValue
        assert.strictEqual(retryTimer.hasRef(), expectedHasRef)
      } finally {
        setTimeoutSpy.restore()
      }
    })
  }

  it('retries an unknown network error once', () => {
    const done = sinon.spy()
    request('payload', {}, done)

    pendingRequests[0].callback(new Error('network failure'))
    clock.tick(6000)

    assert.strictEqual(pendingRequests.length, 2)
    pendingRequests[1].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  it('does not extend the unknown network retry budget during finalization', () => {
    const done = sinon.spy()
    const options = { deadline: Date.now() + 1000, timeout: 2000 }
    request('payload', options, done)
    const firstError = new Error('first network failure')
    const secondError = new Error('second network failure')

    pendingRequests[0].callback(firstError)
    clock.tick(500)
    options.deadline = Date.now() + 2000
    pendingRequests[1].callback(secondError)
    clock.tick(1000)

    assert.strictEqual(pendingRequests.length, 2)
    sinon.assert.calledOnceWithExactly(done, secondError, undefined, undefined, undefined)
  })

  it('does not retry a coded non-transient network error', () => {
    const done = sinon.spy()
    request('payload', {}, done)
    const error = Object.assign(new Error('unknown host'), { code: 'ENOTFOUND' })

    pendingRequests[0].callback(error)
    clock.tick(6000)

    assert.strictEqual(pendingRequests.length, 1)
    sinon.assert.calledOnceWithExactly(done, error, undefined, undefined, undefined)
  })

  it('times out a transport attempt from creation and retries it', () => {
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 30_000, timeout: 1000 }, done)

    const firstRequest = pendingRequests[0]
    firstRequest.options.signal.addEventListener('abort', () => {
      const error = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })
      firstRequest.callback(error)
    })

    clock.tick(999)
    assert.strictEqual(firstRequest.options.signal.aborted, false)
    clock.tick(1)
    clock.next()
    assert.strictEqual(firstRequest.options.signal.aborted, true)
    sinon.assert.notCalled(done)

    clock.tick(5999)
    assert.strictEqual(pendingRequests.length, 1)
    clock.tick(1)
    assert.strictEqual(pendingRequests.length, 2)

    pendingRequests[1].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  it('lets a ready transport response win at the creation-time timeout boundary', () => {
    let abortImmediate
    const immediateHandle = { unref: sinon.spy() }
    const setImmediateStub = sinon.stub(global, 'setImmediate').callsFake(callback => {
      abortImmediate = callback
      return immediateHandle
    })
    const clearImmediateStub = sinon.stub(global, 'clearImmediate')
    const done = sinon.spy()
    try {
      request('payload', { timeout: 1000 }, done)
      const pendingRequest = pendingRequests[0]

      clock.tick(1000)
      assert.strictEqual(pendingRequest.options.signal.aborted, false)
      pendingRequest.callback(null, 'ok', 200, {})
      abortImmediate()

      assert.strictEqual(pendingRequest.options.signal.aborted, false)
      sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
    } finally {
      clearImmediateStub.restore()
      setImmediateStub.restore()
    }
  })

  it('can leave connection timing to the transport for an owned request', () => {
    const done = sinon.spy()
    request('payload', { timeout: 1000, timeoutFromCreation: false }, done)

    clock.tick(1000)

    assert.strictEqual(pendingRequests[0].options.signal.aborted, false)
    assert.strictEqual(pendingRequests[0].options.timeout, 1000)
    sinon.assert.notCalled(done)
  })

  it('reports a transport attempt timeout when retries are disabled', () => {
    const done = sinon.spy()
    request('payload', { retry: false, timeout: 1000 }, done)

    const pendingRequest = pendingRequests[0]
    pendingRequest.options.signal.addEventListener('abort', () => {
      const error = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })
      pendingRequest.callback(error)
    })

    clock.tick(1000)
    clock.next()

    sinon.assert.calledOnce(done)
    assert.strictEqual(done.firstCall.args[0].code, 'ERR_DD_TEST_OPTIMIZATION_REQUEST_TIMEOUT')
  })

  it('aborts a scheduled retry and completes once', () => {
    const controller = new AbortController()
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 10_000, signal: controller.signal }, done)

    const requestError = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    pendingRequests[0].callback(requestError)
    const abortError = Object.assign(new Error('finalization expired'), { code: 'ABORT_ERR' })
    controller.abort(abortError)
    clock.tick(10_000)

    assert.strictEqual(pendingRequests.length, 1)
    sinon.assert.calledOnce(done)
    assert.strictEqual(done.firstCall.args[0], requestError)
  })

  it('reports the abort error when no prior attempt failed', () => {
    const controller = new AbortController()
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 10_000, signal: controller.signal }, done)

    const abortError = Object.assign(new Error('finalization expired'), { code: 'ABORT_ERR' })
    controller.abort(abortError)
    clock.tick(10_000)

    sinon.assert.calledOnce(done)
    assert.strictEqual(done.firstCall.args[0], abortError)
  })

  it('reports a request timeout when finalization aborts an active transport attempt', () => {
    const controller = new AbortController()
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 10_000, signal: controller.signal }, done)

    const finalizationError = Object.assign(new Error('finalization expired'), {
      code: 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT',
    })
    controller.abort(finalizationError)

    sinon.assert.calledOnce(done)
    assert.strictEqual(done.firstCall.args[0].code, 'ERR_DD_TEST_OPTIMIZATION_REQUEST_TIMEOUT')
    assert.strictEqual(pendingRequests[0].options.signal.aborted, true)
  })

  it('preserves the HTTP status when a retry is aborted', () => {
    const controller = new AbortController()
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 10_000, signal: controller.signal }, done)

    const requestError = Object.assign(new Error('unavailable'), { status: 503 })
    pendingRequests[0].callback(requestError, null, 503, {})
    controller.abort(new Error('finalization expired'))

    sinon.assert.calledOnceWithExactly(done, requestError, null, 503, undefined)
  })

  it('stops buffering a readable body when finalization aborts', () => {
    const controller = new AbortController()
    const readable = new Readable({ read () {} })
    const done = sinon.spy()

    request(readable, { signal: controller.signal }, done)
    const abortError = Object.assign(new Error('finalization expired'), { code: 'ABORT_ERR' })
    controller.abort(abortError)

    sinon.assert.calledOnceWithExactly(done, abortError)
    assert.strictEqual(pendingRequests.length, 0)
  })

  it('enforces the queue limit while buffering readable bodies', () => {
    const firstReadable = new Readable({ read () {} })
    const secondReadable = new Readable({ read () {} })
    const rejectedReadable = new Readable({ read () {} })
    const firstDone = sinon.spy()
    const secondDone = sinon.spy()
    const rejectedDone = sinon.spy()

    request(firstReadable, {}, firstDone)
    request(secondReadable, {}, secondDone)
    request(rejectedReadable, {}, rejectedDone)
    const firstChunk = Buffer.alloc(32 * 1024 * 1024)
    const secondChunk = Buffer.alloc(32 * 1024 * 1024)
    firstReadable.emit('data', firstChunk)
    secondReadable.emit('data', secondChunk)
    rejectedReadable.emit('data', Buffer.alloc(1))

    sinon.assert.calledOnce(rejectedDone)
    assert.strictEqual(rejectedDone.firstCall.args[0].code, 'ERR_DD_TEST_OPTIMIZATION_QUEUE_FULL')
    assert.strictEqual(pendingRequests.length, 0)

    firstReadable.emit('end')
    secondReadable.emit('end')
    assert.strictEqual(pendingRequests.length, 2)
    assert.strictEqual(pendingRequests[0].data[0], firstChunk)
    assert.strictEqual(pendingRequests[1].data[0], secondChunk)
    pendingRequests[0].callback(null, 'ok', 200, {})
    pendingRequests[1].callback(null, 'ok', 200, {})
  })

  it('waits for exporter backpressure to clear inside the deadline', () => {
    commonRequest.writable = false
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 1000 }, done)

    clock.tick(49)
    assert.strictEqual(pendingRequests.length, 0)
    commonRequest.writable = true
    clock.tick(1)
    assert.strictEqual(pendingRequests.length, 1)

    pendingRequests[0].callback(null, 'ok', 200, {})
    sinon.assert.calledOnce(done)
  })

  it('waits for exporter backpressure to clear during a background flush', () => {
    commonRequest.writable = false
    const done = sinon.spy()
    request('payload', {}, done)

    clock.tick(49)
    assert.strictEqual(pendingRequests.length, 0)
    commonRequest.writable = true
    clock.tick(1)
    assert.strictEqual(pendingRequests.length, 1)

    pendingRequests[0].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  it('retries when the transport lacks capacity for the payload', () => {
    const done = sinon.spy()
    request('payload', {}, done)
    const error = Object.assign(new Error('request buffer full'), { code: 'ERR_DD_REQUEST_BUFFER_FULL' })

    pendingRequests[0].callback(error)
    clock.tick(49)
    assert.strictEqual(pendingRequests.length, 1)
    clock.tick(1)
    assert.strictEqual(pendingRequests.length, 2)

    pendingRequests[1].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  it('reports backpressure when transport capacity remains unavailable at the deadline', () => {
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 49 }, done)
    const error = Object.assign(new Error('request buffer full'), { code: 'ERR_DD_REQUEST_BUFFER_FULL' })

    pendingRequests[0].callback(error)
    clock.tick(49)

    assert.strictEqual(pendingRequests.length, 1)
    sinon.assert.calledOnce(done)
    assert.strictEqual(done.firstCall.args[0].code, 'ERR_DD_TEST_OPTIMIZATION_BACKPRESSURE_TIMEOUT')
  })

  it('shares one polling timer across concurrent backpressured requests', () => {
    commonRequest.writable = false
    const setTimeoutSpy = sinon.spy(global, 'setTimeout')
    const done = [sinon.spy(), sinon.spy(), sinon.spy()]

    try {
      request('first', {}, done[0])
      request('second', {}, done[1])
      request('third', {}, done[2])

      sinon.assert.calledOnce(setTimeoutSpy)
      assert.strictEqual(clock.countTimers(), 1)

      commonRequest.writable = true
      clock.tick(50)

      assert.strictEqual(pendingRequests.length, 3)
      for (let i = 0; i < pendingRequests.length; i++) {
        pendingRequests[i].callback(null, 'ok', 200, {})
        sinon.assert.calledOnceWithExactly(done[i], null, 'ok', 200, {})
      }
    } finally {
      setTimeoutSpy.restore()
    }
  })

  it('detaches the shared polling timer after its last owned request aborts', () => {
    commonRequest.writable = false
    const setTimeoutSpy = sinon.spy(global, 'setTimeout')
    const backgroundDone = sinon.spy()
    const ownedDone = sinon.spy()
    const ownedController = new AbortController()

    try {
      request('background', {}, backgroundDone)
      request('owned', { keepProcessAlive: true, signal: ownedController.signal }, ownedDone)

      const pollingTimer = setTimeoutSpy.firstCall.returnValue
      assert.strictEqual(pollingTimer.hasRef(), true)

      const abortError = Object.assign(new Error('owned request cancelled'), { code: 'ABORT_ERR' })
      ownedController.abort(abortError)

      assert.strictEqual(pollingTimer.hasRef(), false)
      sinon.assert.calledOnceWithExactly(ownedDone, abortError, null, undefined, undefined)

      commonRequest.writable = true
      clock.tick(50)
      assert.strictEqual(pendingRequests.length, 1)
      pendingRequests[0].callback(null, 'ok', 200, {})
      sinon.assert.calledOnceWithExactly(backgroundDone, null, 'ok', 200, {})
    } finally {
      setTimeoutSpy.restore()
    }
  })

  it('cancels the shared polling timer when its last request aborts', () => {
    commonRequest.writable = false
    const controller = new AbortController()
    const done = sinon.spy()

    request('payload', { signal: controller.signal }, done)
    assert.strictEqual(clock.countTimers(), 1)

    const abortError = Object.assign(new Error('request cancelled'), { code: 'ABORT_ERR' })
    controller.abort(abortError)

    assert.strictEqual(clock.countTimers(), 0)
    sinon.assert.calledOnceWithExactly(done, abortError, null, undefined, undefined)
  })

  it('polls at the earliest queued finalization deadline', () => {
    commonRequest.writable = false
    const backgroundDone = sinon.spy()
    const deadlineDone = sinon.spy()

    request('background', {}, backgroundDone)
    clock.tick(40)
    request('deadline', { deadline: Date.now() + 5 }, deadlineDone)

    assert.strictEqual(clock.countTimers(), 1)
    clock.tick(5)

    sinon.assert.calledOnce(deadlineDone)
    assert.strictEqual(deadlineDone.firstCall.args[0].code, 'ERR_DD_TEST_OPTIMIZATION_BACKPRESSURE_TIMEOUT')
    assert.strictEqual(pendingRequests.length, 0)

    commonRequest.writable = true
    clock.tick(50)
    assert.strictEqual(pendingRequests.length, 1)
    pendingRequests[0].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(backgroundDone, null, 'ok', 200, {})
  })

  it('does not retry a backpressure waiter before its own delay has elapsed', () => {
    commonRequest.writable = false
    const firstDone = sinon.spy()
    const laterDone = sinon.spy()

    request('first', {}, firstDone)
    clock.tick(40)
    request('later', { deadline: Date.now() + 55 }, laterDone)

    clock.tick(10)
    commonRequest.writable = true
    clock.tick(39)
    assert.strictEqual(pendingRequests.length, 0)
    clock.tick(1)

    assert.strictEqual(pendingRequests.length, 1)
    assert.strictEqual(pendingRequests[0].data, 'later')
    pendingRequests[0].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(laterDone, null, 'ok', 200, {})

    clock.tick(10)
    assert.strictEqual(pendingRequests.length, 2)
    assert.strictEqual(pendingRequests[1].data, 'first')
    pendingRequests[1].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(firstDone, null, 'ok', 200, {})
  })

  it('accepts exactly 64 MiB of payloads and rejects the first byte over the cap', () => {
    const firstDone = sinon.spy()
    const secondDone = sinon.spy()
    const rejectedDone = sinon.spy()

    request(Buffer.alloc(32 * 1024 * 1024), {}, firstDone)
    request(Buffer.alloc(32 * 1024 * 1024), {}, secondDone)
    request(Buffer.alloc(1), {}, rejectedDone)

    assert.strictEqual(pendingRequests.length, 2)
    sinon.assert.calledOnce(rejectedDone)
    assert.strictEqual(rejectedDone.firstCall.args[0].code, 'ERR_DD_TEST_OPTIMIZATION_QUEUE_FULL')

    pendingRequests[0].callback(null, 'ok', 200, {})
    pendingRequests[1].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(firstDone, null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(secondDone, null, 'ok', 200, {})
  })

  it('fails at the deadline while exporter backpressure remains active', () => {
    commonRequest.writable = false
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 1000 }, done)

    clock.tick(1000)

    sinon.assert.calledOnce(done)
    assert.strictEqual(done.firstCall.args[0].code, 'ERR_DD_TEST_OPTIMIZATION_BACKPRESSURE_TIMEOUT')
    assert.strictEqual(pendingRequests.length, 0)
  })

  it('rejects a request whose finalization deadline has already elapsed', () => {
    const done = sinon.spy()

    request('payload', { deadline: Date.now() }, done)

    sinon.assert.calledOnce(done)
    assert.strictEqual(done.firstCall.args[0].code, 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT')
    assert.strictEqual(pendingRequests.length, 0)
  })
})
