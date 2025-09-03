'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')

require('../../../../dd-trace/test/setup/tap')

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
    expect(encoder.payloads).to.include.members([payload, payloadSecond])
    expect(encoder.count()).to.equal(2)
    const serializedPayload = encoder.makePayload()
    expect(serializedPayload).to.equal(JSON.stringify([payload, payloadSecond]))
  })
})
