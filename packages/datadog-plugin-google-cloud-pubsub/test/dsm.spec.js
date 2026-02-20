'use strict'

const assert = require('node:assert/strict')

const { after, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

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

        describe('concurrent context isolation', () => {
          it('Should maintain separate DSM context for interleaved consume-produce flows', async () => {
            const setCheckpointSpy = sinon.spy(DataStreamsProcessor.prototype, 'setCheckpoint')

            try {
              const topicAIn = (await pubsub.createTopic(`dsm-iso-a-in-${id()}`))[0]
              const topicBIn = (await pubsub.createTopic(`dsm-iso-b-in-${id()}`))[0]
              const topicAOut = (await pubsub.createTopic(`dsm-iso-a-out-${id()}`))[0]
              const topicBOut = (await pubsub.createTopic(`dsm-iso-b-out-${id()}`))[0]

              const subA = (await topicAIn.createSubscription(`sub-a-${id()}`))[0]
              const subB = (await topicBIn.createSubscription(`sub-b-${id()}`))[0]

              const fullTopicAIn = topicAIn.metadata?.name || topicAIn.name
              const fullTopicBIn = topicBIn.metadata?.name || topicBIn.name
              const fullTopicAOut = topicAOut.metadata?.name || topicAOut.name
              const fullTopicBOut = topicBOut.metadata?.name || topicBOut.name

              // Synchronization: both consumers must receive before either produces
              let resolveAEntered, resolveBEntered
              const aEntered = new Promise(resolve => { resolveAEntered = resolve })
              const bEntered = new Promise(resolve => { resolveBEntered = resolve })
              let doneCount = 0
              const allDone = new Promise(resolve => {
                const check = () => { if (++doneCount === 2) resolve() }
                subA.on('message', async (msg) => {
                  msg.ack()
                  resolveAEntered()
                  await bEntered
                  await publish(topicAOut, { data: Buffer.from('from-a') })
                  check()
                })
                subB.on('message', async (msg) => {
                  msg.ack()
                  resolveBEntered()
                  await aEntered
                  await publish(topicBOut, { data: Buffer.from('from-b') })
                  check()
                })
              })

              await publish(topicAIn, { data: Buffer.from('msg-a') })
              await publish(topicBIn, { data: Buffer.from('msg-b') })

              await allDone

              const calls = setCheckpointSpy.getCalls()
              const checkpoint = (dir, topic) => calls.find(c =>
                c.args[0].includes(`direction:${dir}`) && c.args[0].includes(`topic:${topic}`)
              )

              const consumeA = checkpoint('in', fullTopicAIn)
              const consumeB = checkpoint('in', fullTopicBIn)
              const produceA = checkpoint('out', fullTopicAOut)
              const produceB = checkpoint('out', fullTopicBOut)

              assert.ok(produceA?.args[2], 'Process A produce should have a parent DSM context')
              assert.ok(produceB?.args[2], 'Process B produce should have a parent DSM context')
              assert.deepStrictEqual(produceA.args[2].hash, consumeA.returnValue.hash)
              assert.deepStrictEqual(produceB.args[2].hash, consumeB.returnValue.hash)
            } finally {
              setCheckpointSpy.restore()
            }
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
