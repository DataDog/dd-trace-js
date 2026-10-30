'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../../setup/core')

const BaseWriter = require('../../../../src/exporters/common/writer')
const TestOptimizationRequestTracker = require('../../../../src/ci-visibility/exporters/agentless/request-tracker')

describe('Test Optimization request tracker', () => {
  let clock
  let pendingRequests
  let request

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    pendingRequests = []
    request = (data, options, callback) => {
      pendingRequests.push({ data, options, callback })
    }
    request.writable = true
  })

  afterEach(() => {
    clock?.restore()
  })

  function getWriter () {
    const writer = new BaseWriter({ url: 'http://localhost' })
    const requestTracker = new TestOptimizationRequestTracker(writer)
    writer._encoder = {
      count: sinon.stub(),
      makePayload: sinon.stub().returns(Buffer.from('payload')),
      reset: sinon.stub(),
    }
    writer._sendPayload = (data, count, done, options = {}) => {
      requestTracker.send(request, data, options, done)
    }
    writer.flush = (done, options) => requestTracker.flush(done, options)
    return writer
  }

  it('waits for a request that was already in flight', () => {
    const writer = getWriter()
    writer._encoder.count.onFirstCall().returns(1).returns(0)
    writer.flush()

    const done = sinon.spy()
    const deadline = Date.now() + 1000
    writer.flush(done, { deadline })

    sinon.assert.notCalled(done)
    assert.strictEqual(pendingRequests[0].options.deadline, deadline)
    pendingRequests[0].callback(null)
    sinon.assert.calledOnceWithExactly(done, undefined)
  })

  it('aborts pending requests and releases the process at the deadline', () => {
    const writer = getWriter()
    writer._encoder.count.returns(1)
    const done = sinon.spy()

    writer.flush(done, { deadline: Date.now() + 1000 })
    clock.tick(1000)

    assert.strictEqual(pendingRequests[0].options.signal.aborted, true)
    sinon.assert.calledOnce(done)
    assert.strictEqual(done.firstCall.args[0].code, 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT')
  })

  it('aborts pending requests at the deadline without a completion callback', () => {
    const writer = getWriter()
    writer._encoder.count.returns(1)

    writer.flush(undefined, { deadline: Date.now() + 1000 })
    clock.tick(1000)

    assert.strictEqual(pendingRequests[0].options.signal.aborted, true)
  })

  it('does not wait for a timed-out request on a later final flush', () => {
    const writer = getWriter()
    writer._encoder.count.onFirstCall().returns(1).returns(0)

    writer.flush(sinon.spy(), { deadline: Date.now() + 1000 })
    clock.tick(1000)

    const done = sinon.spy()
    writer.flush(done, { deadline: Date.now() + 1000 })

    sinon.assert.calledOnceWithExactly(done, undefined)
  })

  it('does not let an older deadline abort requests owned by a newer final flush', () => {
    const writer = getWriter()
    writer._encoder.count.returns(1)
    const firstDone = sinon.spy()
    const secondDone = sinon.spy()

    writer.flush(firstDone, { deadline: Date.now() + 1000 })
    clock.tick(100)
    const secondDeadline = Date.now() + 2000
    writer.flush(secondDone, { deadline: secondDeadline })

    clock.tick(900)

    sinon.assert.calledOnce(firstDone)
    assert.strictEqual(firstDone.firstCall.args[0].code, 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT')
    sinon.assert.notCalled(secondDone)
    assert.strictEqual(pendingRequests[0].options.signal.aborted, false)
    assert.strictEqual(pendingRequests[1].options.signal.aborted, false)
    assert.strictEqual(pendingRequests[0].options.deadline, secondDeadline)
    assert.strictEqual(pendingRequests[1].options.deadline, secondDeadline)

    pendingRequests[0].callback(null)
    pendingRequests[1].callback(null)

    sinon.assert.calledOnceWithExactly(secondDone, null)
  })

  it('reports request failures to the final flush callback', () => {
    const writer = getWriter()
    writer._encoder.count.returns(1)
    const done = sinon.spy()
    const error = new Error('intake unavailable')

    writer.flush(done, { deadline: Date.now() + 1000 })
    pendingRequests[0].callback(error)

    sinon.assert.calledOnceWithExactly(done, error)
  })

  it('upgrades an in-flight request and keeps the process alive for its unrefed retry', (done) => {
    clock.restore()
    clock = undefined
    const fixture = path.join(__dirname, 'fixtures', 'final-flush-retry.js')

    execFile(process.execPath, [fixture], { env: { ...process.env, NODE_OPTIONS: '' } }, (error, stdout) => {
      assert.ifError(error)
      assert.strictEqual(stdout, 'flushed')
      done()
    })
  })
})
