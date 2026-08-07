'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../../setup/core')

describe('Test Optimization writer', () => {
  let clock
  let pendingRequests
  let request
  let TestOptimizationWriter

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    pendingRequests = []
    request = (data, options, callback) => {
      pendingRequests.push({ data, options, callback })
    }
    request.writable = true
    TestOptimizationWriter = proxyquire('../../../../src/ci-visibility/exporters/agentless/base-writer', {})
  })

  afterEach(() => {
    clock?.restore()
  })

  function getWriter () {
    const writer = new TestOptimizationWriter({ url: 'http://localhost' })
    writer._encoder = {
      count: sinon.stub(),
      makePayload: sinon.stub().returns(Buffer.from('payload')),
      reset: sinon.stub(),
    }
    writer._sendPayload = function (data, count, done, options = {}) {
      this._sendRequest(request, data, options, done)
    }
    return writer
  }

  it('waits for a request that was already in flight', () => {
    const writer = getWriter()
    writer._encoder.count.onFirstCall().returns(1).returns(0)
    writer.flush()

    const done = sinon.spy()
    writer.flush(done, { deadline: Date.now() + 1000 })

    sinon.assert.notCalled(done)
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

  it('reports request failures to the final flush callback', () => {
    const writer = getWriter()
    writer._encoder.count.returns(1)
    const done = sinon.spy()
    const error = new Error('intake unavailable')

    writer.flush(done, { deadline: Date.now() + 1000 })
    pendingRequests[0].callback(error)

    sinon.assert.calledOnceWithExactly(done, error)
  })

  it('keeps the process alive for an unrefed final-payload retry', (done) => {
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
