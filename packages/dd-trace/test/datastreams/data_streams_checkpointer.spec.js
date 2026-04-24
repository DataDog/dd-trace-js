'use strict'

const assert = require('node:assert/strict')

const { describe, it, before, after } = require('mocha')
const sinon = require('sinon')

require('../setup/core')
const { storage } = require('../../../datadog-core')
const agent = require('../plugins/agent')

const { computePathwayHash, encodePathwayContextBase64 } = require('../../src/datastreams/pathway')
const { ENTRY_PARENT_HASH } = require('../../src/datastreams/processor')
const propagationHash = require('../../src/propagation-hash')

const DSM_CONTEXT_HEADER = 'dd-pathway-ctx-base64'

describe('data streams checkpointer manual api', () => {
  let tracer
  let expectedProducerHash
  let expectedConsumerHash
  let encodedProducerContext

  before(async () => {
    process.env.DD_DATA_STREAMS_ENABLED = 'true'
    tracer = require('../..').init()
    await agent.load(null, { dsmEnabled: true })

    // Compute expected hashes using the actual service/env/propagationHash that the processor will use
    const proc = tracer._tracer._dataStreamsProcessor
    const service = proc.service
    const env = proc.env
    const phash = propagationHash.getHash()

    const producerHash = computePathwayHash(
      service, env,
      ['direction:out', 'topic:test-queue', 'type:testProduce'],
      ENTRY_PARENT_HASH,
      phash
    )
    expectedProducerHash = producerHash.readBigUInt64LE(0).toString()

    encodedProducerContext = encodePathwayContextBase64({
      hash: producerHash,
      pathwayStartNs: 0,
      edgeStartNs: 0,
    })

    const consumerHash = computePathwayHash(
      service, env,
      ['direction:in', 'topic:test-queue', 'type:testConsume'],
      producerHash,
      phash
    )
    expectedConsumerHash = consumerHash.readBigUInt64LE(0).toString()
  })

  after(() => {
    return agent.close({ ritmReset: false })
  })

  it('should set a checkpoint when calling setProduceCheckpoint', function (done) {
    const expectedEdgeTags = ['direction:out', 'manual_checkpoint:true', 'topic:test-queue', 'type:testProduce']

    agent.expectPipelineStats(dsmStats => {
      let statsPointsReceived = 0
      // we should have 1 dsm stats points
      for (const timeStatsBucket of dsmStats) {
        if (timeStatsBucket && timeStatsBucket.Stats) {
          for (const statsBucket of timeStatsBucket.Stats) {
            statsPointsReceived += statsBucket.Stats.length
          }
        }
      }

      assert.strictEqual(statsPointsReceived, 1)
      assert.strictEqual(agent.dsmStatsExist(agent, expectedProducerHash, expectedEdgeTags), true)
    }, { timeoutMs: 5000 }).then(done, done)

    const headers = {}

    tracer.dataStreamsCheckpointer.setProduceCheckpoint('testProduce', 'test-queue', headers)

    assert.strictEqual(DSM_CONTEXT_HEADER in headers, true)
  })

  it('should set a checkpoint when calling setConsumeCheckpoint', function (done) {
    const expectedEdgeTags = ['direction:in', 'manual_checkpoint:true', 'topic:test-queue', 'type:testConsume']

    agent.expectPipelineStats(dsmStats => {
      let statsPointsReceived = 0
      // we should have 2 dsm stats points because of the earlier produce
      for (const timeStatsBucket of dsmStats) {
        if (timeStatsBucket && timeStatsBucket.Stats) {
          for (const statsBucket of timeStatsBucket.Stats) {
            statsPointsReceived += statsBucket.Stats.length
          }
        }
      }
      assert.strictEqual(statsPointsReceived, 2)
      assert.strictEqual(agent.dsmStatsExist(agent, expectedConsumerHash, expectedEdgeTags), true)
    }, { timeoutMs: 5000 }).then(done, done)

    const headers = {
      [DSM_CONTEXT_HEADER]: encodedProducerContext,
    }

    tracer.dataStreamsCheckpointer.setConsumeCheckpoint('testConsume', 'test-queue', headers)

    assert.strictEqual(DSM_CONTEXT_HEADER in headers, true)
  })

  it('should set manual checkpoint when setConsumeCheckpoint is called without additional parameters', function () {
    const headers = {}
    const mockSetCheckpoint = sinon.stub().returns({ hash: Buffer.from([1, 2, 3, 4]) })

    tracer._tracer._dataStreamsProcessor.setCheckpoint = mockSetCheckpoint

    tracer.dataStreamsCheckpointer.setConsumeCheckpoint('kinesis', 'stream-123', headers)
    const calledTags = mockSetCheckpoint.getCall(0).args[0]
    assert.deepStrictEqual(calledTags, ['type:kinesis', 'topic:stream-123', 'direction:in', 'manual_checkpoint:true'])
  })

  it('should set an automatic checkpoint when setConsumeCheckpoint is called with manualCheckpoint:false', function () {
    const headers = {}
    const mockSetCheckpoint = sinon.stub().returns({ hash: Buffer.from([1, 2, 3, 4]) })

    tracer._tracer._dataStreamsProcessor.setCheckpoint = mockSetCheckpoint

    tracer.dataStreamsCheckpointer.setConsumeCheckpoint('kinesis', 'stream-123', headers, false)
    const calledTags = mockSetCheckpoint.getCall(0).args[0]
    assert.ok(!calledTags.includes('manual_checkpoint:true'))
  })

  it('should call trackTransaction on the processor with correct args', function () {
    const mockTrackTransaction = sinon.stub()
    tracer._tracer._dataStreamsProcessor.trackTransaction = mockTrackTransaction

    tracer.dataStreamsCheckpointer.trackTransaction('msg-id-001', 'ingested')

    sinon.assert.calledOnce(mockTrackTransaction)
    // Third arg is the active span (null when no span is active in this test context)
    sinon.assert.calledWith(mockTrackTransaction, 'msg-id-001', 'ingested', null)
  })

  it('should pass an explicit span to the processor', function () {
    const mockTrackTransaction = sinon.stub()
    tracer._tracer._dataStreamsProcessor.trackTransaction = mockTrackTransaction
    const span = { setTag: sinon.stub() }

    tracer.dataStreamsCheckpointer.trackTransaction('msg-id-001', 'ingested', span)

    sinon.assert.calledWith(mockTrackTransaction, 'msg-id-001', 'ingested', span)
  })

  it('should use the active span when no span is provided', function () {
    const mockTrackTransaction = sinon.stub()
    tracer._tracer._dataStreamsProcessor.trackTransaction = mockTrackTransaction
    const activeSpan = { setTag: sinon.stub() }

    storage('legacy').run({ span: activeSpan }, () => {
      tracer.dataStreamsCheckpointer.trackTransaction('msg-id-001', 'ingested')
      sinon.assert.calledWith(mockTrackTransaction, 'msg-id-001', 'ingested', activeSpan)
    })
  })

  it('trackTransaction is a no-op when dsmEnabled is false', function () {
    const mockTrackTransaction = sinon.stub()
    tracer._tracer._dataStreamsProcessor.trackTransaction = mockTrackTransaction

    const originalDsmEnabled = tracer._tracer._config.dsmEnabled
    tracer._tracer._config.dsmEnabled = false

    tracer.dataStreamsCheckpointer.trackTransaction('msg-id-001', 'ingested')

    sinon.assert.notCalled(mockTrackTransaction)

    tracer._tracer._config.dsmEnabled = originalDsmEnabled
  })
})
