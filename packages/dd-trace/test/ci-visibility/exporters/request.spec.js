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

  it('keeps the ordinary attempt cap during finalization', () => {
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 30_000 }, done)
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
