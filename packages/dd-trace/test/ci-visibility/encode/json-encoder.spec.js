'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

require('../../../../dd-trace/test/setup/core')
const { JSONEncoder } = require('../../../src/ci-visibility/encode/json-encoder')

describe('CI Visibility JSON encoder', () => {
  let send, originalSend

  beforeEach(() => {
    send = sinon.spy()
    originalSend = process.send
    process.send = send
  })

  afterEach(() => {
    process.send = originalSend
  })

  it('can JSON serialize payloads', () => {
    const payload = [{ type: 'test' }, { type: 'test', name: 'test2' }]
    const payloadSecond = { type: 'test', name: 'other' }
    const encoder = new JSONEncoder()
    encoder.encode(payload)
    encoder.encode(payloadSecond)
    assert.strictEqual(encoder.count(), 2)
    const serializedPayload = encoder.makePayload()
    assert.strictEqual(serializedPayload, JSON.stringify([payload, payloadSecond]))
  })

  it('accepts payloads through its byte limit and rejects the first payload over it', () => {
    const encoder = new JSONEncoder(3)

    assert.strictEqual(encoder.encode(1), true)
    assert.strictEqual(encoder.encode(2), false)
    assert.strictEqual(encoder.count(), 1)
    assert.deepStrictEqual(encoder.makePayload(), ['[', '1', ']'])
  })

  it('serializes each bounded payload once', () => {
    let reads = 0
    const encoder = new JSONEncoder(64)
    const payload = {
      get value () {
        reads++
        return 'test'
      },
    }

    encoder.encode(payload)
    assert.deepStrictEqual(encoder.makePayload(), ['[', '{"value":"test"}', ']'])
    assert.strictEqual(reads, 1)
  })

  it('counts UTF-8 bytes and separators and releases the budget after sending', () => {
    const encoder = new JSONEncoder(8)

    assert.strictEqual(encoder.encode('é'), true)
    assert.strictEqual(encoder.encode(0), true)
    assert.strictEqual(encoder.encode(1), false)
    assert.strictEqual(encoder.makePayload().join(''), '["é",0]')
    assert.strictEqual(encoder.encode(1), true)
    assert.strictEqual(encoder.makePayload().join(''), '[1]')
  })
})
