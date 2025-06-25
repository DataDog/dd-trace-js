'use strict'

const t = require('tap')
require('../../../../dd-trace/test/setup/core')

const { JSONEncoder } = require('../../../src/ci-visibility/encode/json-encoder')

t.test('CI Visibility JSON encoder', t => {
  let send, originalSend

  t.beforeEach(() => {
    send = sinon.spy()
    originalSend = process.send
    process.send = send
  })

  t.afterEach(() => {
    process.send = originalSend
  })

  t.test('can JSON serialize payloads', t => {
    const payload = [{ type: 'test' }, { type: 'test', name: 'test2' }]
    const payloadSecond = { type: 'test', name: 'other' }
    const encoder = new JSONEncoder()
    encoder.encode(payload)
    encoder.encode(payloadSecond)
    expect(encoder.payloads).to.include.members([payload, payloadSecond])
    expect(encoder.count()).to.equal(2)
    const serializedPayload = encoder.makePayload()
    expect(serializedPayload).to.equal(JSON.stringify([payload, payloadSecond]))
    t.end()
  })
  t.end()
})
