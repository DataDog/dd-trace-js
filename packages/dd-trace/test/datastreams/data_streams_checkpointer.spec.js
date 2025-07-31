'use strict'

require('../setup/tap')

const agent = require('../plugins/agent')

const expectedProducerHash = '11316777716831864733'
const expectedConsumerHash = '685328872879070794'
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
    }, { timeoutMs: 5000 }).then(done, done)

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
    }, { timeoutMs: 5000 }).then(done, done)

    const headers = {
      [DSM_CONTEXT_HEADER]: 'ncfR5V9FDZ3E58Cfj2LI2cOfj2I=' // same context as previous produce
    }

    tracer.dataStreamsCheckpointer.setConsumeCheckpoint('testConsume', 'test-queue', headers)

    expect(DSM_CONTEXT_HEADER in headers).to.equal(true)
  })
})
