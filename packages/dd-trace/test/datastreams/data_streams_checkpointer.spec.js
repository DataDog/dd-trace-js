'use strict'

require('../setup/tap')

const agent = require('../plugins/agent')

const expectedProducerHash = '11369286567396183453'
const expectedConsumerHash = '11204511019589278729'
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
      expect(statsPointsReceived).to.equal(1)
      expect(agent.dsmStatsExist(agent, expectedProducerHash, expectedEdgeTags)).to.equal(true)
    }).then(done, done)

    const headers = {}

    tracer.dataStreamsCheckpointer.setProduceCheckpoint('testProduce', 'test-queue', headers)

    expect(DSM_CONTEXT_HEADER in headers).to.equal(true)
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
      expect(statsPointsReceived).to.equal(2)
      expect(agent.dsmStatsExist(agent, expectedConsumerHash, expectedEdgeTags)).to.equal(true)
    }).then(done, done)

    const headers = {
      [DSM_CONTEXT_HEADER]: 'tvMEiT2p8cjWzqLRnGTWzqLRnGQ=' // same context as previous produce
    }

    tracer.dataStreamsCheckpointer.setConsumeCheckpoint('testConsume', 'test-queue', headers)

    expect(DSM_CONTEXT_HEADER in headers).to.equal(true)
  })
})
