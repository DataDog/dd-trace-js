'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

const writer = {
  flush: sinon.stub(),
}
const DataStreamsWriter = sinon.stub().returns(writer)
const { DataStreamsProcessor } = proxyquire('../../src/datastreams/processor', {
  './writer': { DataStreamsWriter },
})

const DEFAULT_TIMESTAMP = Number(new Date('2023-04-20T16:20:00.000Z'))

const baseConfig = {
  dsmEnabled: true,
  hostname: '127.0.0.1',
  port: 8126,
  url: new URL('http://127.0.0.1:8126'),
  env: 'test',
  version: 'v1',
  service: 'service1',
  tags: { foo: 'foovalue', bar: 'barvalue' },
}

const checkpoint = {
  currentTimestamp: DEFAULT_TIMESTAMP,
  hash: Buffer.from('e858212fd11a41e5', 'hex'),
  parentHash: Buffer.from('e858292fd15a41e4', 'hex'),
  edgeTags: ['service:service-name', 'env:env-name', 'topic:test-topic'],
  edgeLatencyNs: 100000000,
  pathwayLatencyNs: 100000000,
  payloadSize: 100,
}

// `flushInterval: 0` is the "flush on write" sentinel the agent/agentless trace exporters already
// honor. The processor must push each recorded checkpoint immediately, while the writer URL is known
// live. The previous `setInterval(onInterval, 0)` fired on every event-loop tick instead, decoupled
// from the recording, so a tick landing after the agent listener was torn down posted to a dead port
// and lost the bucket (it is cleared on serialize) — dropping the single payload a producer-only DSM
// test waits for and timing it out.
describe('DataStreamsProcessor flush-on-write', () => {
  let processor

  afterEach(() => {
    clearTimeout(processor?.timer)
    writer.flush.resetHistory()
  })

  describe('with flushInterval 0', () => {
    beforeEach(() => {
      processor = new DataStreamsProcessor({ ...baseConfig, flushInterval: 0 })
    })

    it('does not arm an interval timer', () => {
      assert.strictEqual(processor.timer, undefined)
    })

    it('flushes synchronously while recording a checkpoint', () => {
      processor.recordCheckpoint(checkpoint)

      sinon.assert.calledOnce(writer.flush)
    })

    it('flushes synchronously while recording an offset', () => {
      processor.recordOffset({ timestamp: DEFAULT_TIMESTAMP, partition: 0, topic: 'test-topic' })

      sinon.assert.calledOnce(writer.flush)
    })

    it('flushes synchronously while tracking a transaction', () => {
      processor.trackTransaction('msg-id-001', 'ingested')

      sinon.assert.calledOnce(writer.flush)
    })
  })

  describe('with a non-zero flushInterval', () => {
    beforeEach(() => {
      processor = new DataStreamsProcessor({ ...baseConfig, flushInterval: 1000 })
    })

    it('arms an interval timer', () => {
      assert.notStrictEqual(processor.timer, undefined)
    })

    it('does not flush while recording a checkpoint', () => {
      processor.recordCheckpoint(checkpoint)

      sinon.assert.notCalled(writer.flush)
    })
  })
})
