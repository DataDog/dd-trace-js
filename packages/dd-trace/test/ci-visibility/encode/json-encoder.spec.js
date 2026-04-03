'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const { assertObjectContains } = require('../../../../../integration-tests/helpers')
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
    assertObjectContains(encoder.payloads, [payload, payloadSecond])
    assert.strictEqual(encoder.count(), 2)
    const serializedPayload = encoder.makePayload()
    assert.strictEqual(serializedPayload, JSON.stringify([payload, payloadSecond]))
  })
})
