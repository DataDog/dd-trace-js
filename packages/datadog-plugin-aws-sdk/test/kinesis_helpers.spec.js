'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { waitForActiveStream, waitForDeletedStream } = require('./kinesis_helpers')

describe('Kinesis helpers', () => {
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers()
  })

  afterEach(() => {
    clock.restore()
  })

  it('paces polling until the stream is active', () => {
    const cb = sinon.spy()
    const describeStream = sinon.stub()
    describeStream.onFirstCall().yields(new Error('not found'))
    describeStream.onSecondCall().yields(null, {
      StreamDescription: { StreamStatus: 'CREATING' },
    })
    describeStream.onThirdCall().yields(null, {
      StreamDescription: { StreamStatus: 'ACTIVE' },
    })

    waitForActiveStream({ describeStream }, 'test-stream', cb)

    assert.strictEqual(describeStream.callCount, 1)
    assert.strictEqual(cb.callCount, 0)
    clock.tick(99)
    assert.strictEqual(describeStream.callCount, 1)
    clock.tick(1)
    assert.strictEqual(describeStream.callCount, 2)
    assert.strictEqual(cb.callCount, 0)
    clock.tick(100)
    assert.strictEqual(describeStream.callCount, 3)
    assert.strictEqual(cb.callCount, 1)
  })

  it('paces polling until the stream is deleted', () => {
    const cb = sinon.spy()
    const describeStream = sinon.stub()
    describeStream.onFirstCall().yields(null, {
      StreamDescription: { StreamStatus: 'DELETING' },
    })
    describeStream.onSecondCall().yields(new Error('not found'))

    waitForDeletedStream({ describeStream }, 'test-stream', cb)

    assert.strictEqual(describeStream.callCount, 1)
    assert.strictEqual(cb.callCount, 0)
    clock.tick(99)
    assert.strictEqual(describeStream.callCount, 1)
    clock.tick(1)
    assert.strictEqual(describeStream.callCount, 2)
    assert.strictEqual(cb.callCount, 1)
  })
})
