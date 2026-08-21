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

  it('retries an opted-in 5xx response without a finalization deadline', () => {
    const done = sinon.spy()
    request('payload', { retryHttpErrors: true }, done)

    const error = Object.assign(new Error('unavailable'), { status: 503 })
    pendingRequests[0].callback(error, null, 503, {})
    clock.tick(5999)
    assert.strictEqual(pendingRequests.length, 1)
    clock.tick(1)
    assert.strictEqual(pendingRequests.length, 2)

    pendingRequests[1].callback(null, 'ok', 200, {})
    sinon.assert.calledOnceWithExactly(done, null, 'ok', 200, {})
  })

  it('does not retry a 5xx response without a deadline or explicit opt-in', () => {
    const done = sinon.spy()
    request('payload', {}, done)

    const error = Object.assign(new Error('unavailable'), { status: 503 })
    pendingRequests[0].callback(error, null, 503, {})
    clock.tick(6000)

    assert.strictEqual(pendingRequests.length, 1)
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

  it('waits for an opted-in rate-limit reset without a finalization deadline', () => {
    const done = sinon.spy()
    request('payload', { retryHttpErrors: true }, done)

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
    assert.strictEqual(done.firstCall.args[0], abortError)
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

  it('fails at the deadline while exporter backpressure remains active', () => {
    commonRequest.writable = false
    const done = sinon.spy()
    request('payload', { deadline: Date.now() + 1000 }, done)

    clock.tick(1000)

    sinon.assert.calledOnce(done)
    assert.strictEqual(done.firstCall.args[0].code, 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT')
    assert.strictEqual(pendingRequests.length, 0)
  })
})
