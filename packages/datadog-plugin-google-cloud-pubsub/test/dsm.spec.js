'use strict'

const assert = require('node:assert/strict')

const { after, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const DataStreamsContext = require('../../dd-trace/src/datastreams/context')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH, DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')
const id = require('../../dd-trace/src/id')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const TIMEOUT = 30000
const dsmTopicName = 'dsm-topic'

describe('Plugin', () => {
  let tracer

  describe('google-cloud-pubsub', function () {
    this.timeout(TIMEOUT)

    before(() => {
      process.env.PUBSUB_EMULATOR_HOST = 'localhost:8081'
      process.env.DD_DATA_STREAMS_ENABLED = 'true'
    })

    after(() => {
      delete process.env.PUBSUB_EMULATOR_HOST
    })

    after(() => {
      return agent.close({ ritmReset: false })
    })

    withVersions('google-cloud-pubsub', '@google-cloud/pubsub', version => {
      let pubsub
      let project
      let expectedProducerHash
      let expectedConsumerHash

      describe('data stream monitoring', () => {
        let dsmTopic
        let sub
        let consume

        before(async () => {
          tracer = require('../../dd-trace')
          await agent.load('google-cloud-pubsub', {
            dsmEnabled: true,
          })
          tracer.use('google-cloud-pubsub', { dsmEnabled: true })

          const { PubSub } = require(`../../../versions/@google-cloud/pubsub@${version}`).get()
          project = getProjectId()
          pubsub = new PubSub({ projectId: project })

          dsmTopic = await pubsub.createTopic(dsmTopicName)
          dsmTopic = dsmTopic[0]
          sub = await dsmTopic.createSubscription('DSM')
          sub = sub[0]
          consume = function (cb) {
            sub.on('message', cb)
          }

          const dsmFullTopic = `projects/${project}/topics/${dsmTopicName}`

          expectedProducerHash = computePathwayHash(
            'test',
            'tester',
            ['direction:out', 'topic:' + dsmFullTopic, 'type:google-pubsub'],
            ENTRY_PARENT_HASH
          )
          expectedConsumerHash = computePathwayHash(
            'test',
            'tester',
            ['direction:in', 'topic:' + dsmFullTopic, 'type:google-pubsub'],
            expectedProducerHash
          )
        })

        beforeEach(() => {
          return agent.load('google-cloud-pubsub', {
            dsmEnabled: true,
          })
        })

        describe('should set a DSM checkpoint', () => {
          it('on produce', async () => {
            await publish(dsmTopic, { data: Buffer.from('DSM produce checkpoint') })

            agent.expectPipelineStats(dsmStats => {
              let statsPointsReceived = 0
              // we should have 1 dsm stats points
              dsmStats.forEach((timeStatsBucket) => {
                if (timeStatsBucket && timeStatsBucket.Stats) {
                  timeStatsBucket.Stats.forEach((statsBuckets) => {
                    statsPointsReceived += statsBuckets.Stats.length
                  })
                }
              })
              assert.ok(statsPointsReceived >= 1)
              assert.strictEqual(agent.dsmStatsExist(agent, expectedProducerHash.readBigUInt64BE(0).toString()), true)
            }, { timeoutMs: TIMEOUT })
          })

          it('on consume', async () => {
            await publish(dsmTopic, { data: Buffer.from('DSM consume checkpoint') })
            await consume(async () => {
              agent.expectPipelineStats(dsmStats => {
                let statsPointsReceived = 0
                // we should have 2 dsm stats points
                dsmStats.forEach((timeStatsBucket) => {
                  if (timeStatsBucket && timeStatsBucket.Stats) {
                    timeStatsBucket.Stats.forEach((statsBuckets) => {
                      statsPointsReceived += statsBuckets.Stats.length
                    })
                  }
                })
                assert.ok(statsPointsReceived >= 2)
                assert.strictEqual(agent.dsmStatsExist(agent, expectedConsumerHash.readBigUInt64BE(0).toString()), true)
              }, { timeoutMs: TIMEOUT })
            })
          })
        })

        describe('it should set a message payload size', () => {
          let recordCheckpointSpy

          beforeEach(() => {
            recordCheckpointSpy = sinon.spy(DataStreamsProcessor.prototype, 'recordCheckpoint')
          })

          afterEach(() => {
            DataStreamsProcessor.prototype.recordCheckpoint.restore()
          })

          it('when producing a message', async () => {
            await publish(dsmTopic, { data: Buffer.from('DSM produce payload size') })
            assert.ok(recordCheckpointSpy.args[0][0].hasOwnProperty('payloadSize'))
          })

          it('when consuming a message', async () => {
            await publish(dsmTopic, { data: Buffer.from('DSM consume payload size') })

            await consume(async () => {
              assert.ok(recordCheckpointSpy.args[0][0].hasOwnProperty('payloadSize'))
            })
          })
        })

        describe('syncToStore', () => {
          let syncToStoreSpy

          beforeEach(() => {
            syncToStoreSpy = sinon.spy(DataStreamsContext, 'syncToStore')
          })

          afterEach(() => {
            syncToStoreSpy.restore()
          })

          it('should call syncToStore after producing', async () => {
            await publish(dsmTopic, { data: Buffer.from('syncToStore produce test') })
            assert.ok(syncToStoreSpy.called, 'syncToStore should be called on produce')
          })

          it('should call syncToStore after consuming', async () => {
            await publish(dsmTopic, { data: Buffer.from('syncToStore consume test') })
            await consume(async () => {
              assert.ok(syncToStoreSpy.called, 'syncToStore should be called on consume')
            })
          })
        })
      })
    })
  })
})

function getProjectId () {
  return `test-project-dsm-${id()}`
}

function publish (topic, options) {
  if (topic.publishMessage) {
    return topic.publishMessage(options)
  } else {
    return topic.publish(options.data)
  }
}
