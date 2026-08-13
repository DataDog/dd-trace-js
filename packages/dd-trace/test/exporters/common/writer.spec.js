'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')
const { MAX_SIZE, OverflowError } = require('../../../src/msgpack')

describe('common Writer', () => {
  let Writer
  let writer
  let encoder
  let request
  let log

  beforeEach(() => {
    encoder = {
      count: sinon.stub().returns(2),
      encode: sinon.stub(),
      makePayload: sinon.stub().returns(Buffer.from('payload')),
      reset: sinon.stub(),
    }

    request = sinon.stub()
    request.writable = true

    log = { error: sinon.stub(), debug: sinon.stub() }

    Writer = proxyquire('../../../src/exporters/common/writer', {
      './request': request,
      '../../log': log,
    })

    writer = new Writer({ url: 'http://localhost:8126' })
    writer._encoder = encoder
    writer._sendPayload = sinon.stub()
  })

  it('drops the payload and resets when makePayload hits the chunk cap', () => {
    // The v0.5 encoder concatenates the string table and trace bytes, and the
    // CI Visibility encoder builds its metadata prefix, only inside
    // `makePayload` — after `encode` already returned. An assembled payload
    // over the cap therefore overflows here, where the encode-time catch can
    // never see it. Without this flush-time catch the RangeError escapes
    // straight into the host application.
    encoder.makePayload.throws(new OverflowError(MAX_SIZE + 1))
    const done = sinon.stub()

    writer.flush(done)

    sinon.assert.calledOnce(encoder.reset)
    sinon.assert.calledOnce(log.error)
    sinon.assert.notCalled(writer._sendPayload)
    sinon.assert.calledOnce(done)
  })

  it('rethrows non-overflow makePayload errors', () => {
    encoder.makePayload.throws(new Error('not an overflow'))

    assert.throws(() => writer.flush(), /not an overflow/)
    sinon.assert.notCalled(writer._sendPayload)
  })

  it('sends the payload when makePayload succeeds', () => {
    const payload = Buffer.from('payload')
    encoder.makePayload.returns(payload)
    const done = sinon.stub()

    writer.flush(done)

    sinon.assert.notCalled(encoder.reset)
    sinon.assert.calledOnceWithExactly(writer._sendPayload, payload, 2, done)
  })

  it('routes automatic flushes through the configured delivery tracker', () => {
    const deliveryTracker = { track: sinon.stub().callsFake((flush, done) => flush(done)) }
    writer = new Writer({ url: 'http://localhost:8126', deliveryTracker })
    writer._encoder = encoder
    writer._sendPayload = sinon.stub()

    writer.flush()

    sinon.assert.calledOnce(deliveryTracker.track)
    sinon.assert.calledOnce(writer._sendPayload)
  })

  it('passes final flush options to the payload sender', () => {
    const done = sinon.stub()
    const options = { deadline: Date.now() + 1000 }

    writer.flush(done, options)

    sinon.assert.calledOnceWithExactly(
      writer._sendPayload,
      Buffer.from('payload'),
      2,
      done,
      options
    )
  })

  it('drops a non-final payload when the request buffer is full', () => {
    request.writable = false
    const done = sinon.stub()

    writer.flush(done)

    sinon.assert.calledOnce(encoder.reset)
    sinon.assert.calledOnceWithExactly(done)
  })

  it('sends a bounded final payload when the request buffer is full', () => {
    request.writable = false
    const done = sinon.stub()
    const options = { deadline: Date.now() + 1000 }

    writer.flush(done, options)

    sinon.assert.notCalled(encoder.reset)
    sinon.assert.calledOnceWithExactly(
      writer._sendPayload,
      Buffer.from('payload'),
      2,
      done,
      options
    )
  })

  it('reports whether an appended payload was accepted', () => {
    const payload = [{ type: 'test_suite_end' }]

    assert.strictEqual(writer.append(payload), true)
    sinon.assert.calledOnceWithExactly(encoder.encode, payload)

    request.writable = false
    assert.strictEqual(writer.append(payload), false)
    sinon.assert.calledOnce(encoder.encode)
  })

  it('accepts a bounded final append when the request buffer is full', () => {
    request.writable = false
    const payload = [{ type: 'test_suite_end' }]
    const options = { deadline: Date.now() + 1000 }

    assert.strictEqual(writer.append(payload, options), true)
    sinon.assert.calledOnceWithExactly(encoder.encode, payload)
  })

  it('resetPendingBatch discards the pending encoded batch', () => {
    writer.resetPendingBatch()

    sinon.assert.calledOnce(encoder.reset)
  })
})
