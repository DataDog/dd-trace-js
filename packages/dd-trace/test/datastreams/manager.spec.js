'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const { storage } = require('../../../datadog-core')
const { DataStreamsManager } = require('../../src/datastreams/manager')
const { DsmPathwayCodec } = require('../../src/datastreams/pathway')

const writer = { flush: sinon.stub() }
const DataStreamsWriter = sinon.stub().returns(writer)
const { DataStreamsProcessor, ENTRY_PARENT_HASH } = proxyquire('../../src/datastreams/processor', {
  './writer': { DataStreamsWriter },
})

const CONSUMER_EDGE_TAGS = ['direction:in', 'topic:queue', 'type:sqs']
const PRODUCER_HASH_HEX = 'e858292fd15a41e4'
const PRODUCER_HASH = Buffer.from(PRODUCER_HASH_HEX, 'hex')
const ENTRY_PARENT_HASH_HEX = ENTRY_PARENT_HASH.toString('hex')
const config = {
  dsmEnabled: true,
  env: 'test',
  hostname: '127.0.0.1',
  port: 8126,
  service: 'service1',
  tags: {},
  url: new URL('http://127.0.0.1:8126'),
  version: 'v1',
}

describe('DataStreamsManager', () => {
  let manager
  let recordCheckpoint

  beforeEach(() => {
    const processor = new DataStreamsProcessor(config)
    clearTimeout(processor.timer)
    recordCheckpoint = sinon.stub(processor, 'recordCheckpoint')
    manager = new DataStreamsManager(processor)
  })

  /**
   * @param {Array<Record<string, string>|undefined>} carriers Consumed in order, the way a batch
   *   consumer hands its messages over.
   */
  function parentHashesForBatch (carriers) {
    return storage('legacy').run({}, () => {
      for (const carrier of carriers) {
        manager.decodeDataStreamsContext(carrier)
        manager.setCheckpoint(CONSUMER_EDGE_TAGS, null, 10)
      }
      return recordCheckpoint.getCalls().map(call => call.args[0].parentHash.toString('hex'))
    })
  }

  function producerCarrier () {
    return DsmPathwayCodec.encode({ hash: PRODUCER_HASH, pathwayStartNs: 1e6, edgeStartNs: 1e6 })
  }

  // Async on purpose: `.mocharc.js` sets `allowUncaught`, under which mocha rethrows a synchronous
  // failure out of its own runner and the process can exit 0 without reporting it. A rejected
  // promise goes through mocha's reporting instead, so these fail visibly.
  it('parents the checkpoint on the context the message carried', async () => {
    assert.deepStrictEqual(parentHashesForBatch([producerCarrier()]), [PRODUCER_HASH_HEX])
  })

  it('starts a new pathway for a message that carries a carrier without a pathway', async () => {
    assert.deepStrictEqual(
      parentHashesForBatch([producerCarrier(), { 'x-datadog-trace-id': '1' }]),
      [PRODUCER_HASH_HEX, ENTRY_PARENT_HASH_HEX]
    )
  })
  it('starts a new pathway for a message that carries no carrier at all', async () => {
    assert.deepStrictEqual(
      parentHashesForBatch([producerCarrier(), undefined]),
      [PRODUCER_HASH_HEX, ENTRY_PARENT_HASH_HEX]
    )
  })
})
