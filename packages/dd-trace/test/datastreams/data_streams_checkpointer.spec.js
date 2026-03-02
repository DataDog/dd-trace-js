'use strict'

const assert = require('node:assert/strict')

const { describe, it, before, after } = require('mocha')
const sinon = require('sinon')

require('../setup/core')
const agent = require('../plugins/agent')

const expectedProducerHash = '6359420180750536220'
const expectedConsumerHash = '13652937079614409115'
const DSM_CONTEXT_HEADER = 'dd-pathway-ctx-base64'

describe('data streams checkpointer manual api', () => {
  let tracer

  before(() => {
    process.env.DD_DATA_STREAMS_ENABLED = 'true'
    tracer = require('../..').init()
    agent.load(null, { dsmEnabled: true })
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
      [DSM_CONTEXT_HEADER]: 'ncfR5V9FDZ3E58Cfj2LI2cOfj2I=', // same context as previous produce
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
    sinon.assert.calledWith(mockTrackTransaction, 'msg-id-001', 'ingested')
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
