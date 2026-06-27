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
})
