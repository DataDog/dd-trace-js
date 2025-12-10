'use strict'

const { randomUUID } = require('crypto')
const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, before } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { withVersions } = require('../../setup/mocha')
const agent = require('../../plugins/agent')

const DataStreamsContext = require('../../../src/datastreams/context')
const { computePathwayHash } = require('../../../src/datastreams/pathway')
const { ENTRY_PARENT_HASH, DataStreamsProcessor } = require('../../../src/datastreams/processor')

const testKafkaClusterId = '5L6g3nShT-eMCtK--X86sw'

const getDsmPathwayHash = (testTopic, clusterIdAvailable, isProducer, parentHash) => {
  let edgeTags
  if (isProducer) {
    edgeTags = ['direction:out', 'topic:' + testTopic, 'type:kafka']
  } else {
    edgeTags = ['direction:in', 'group:test-group', 'topic:' + testTopic, 'type:kafka']
  }

  if (clusterIdAvailable) {
    edgeTags.push(`kafka_cluster_id:${testKafkaClusterId}`)
  }
  edgeTags.sort()
  return computePathwayHash('test', 'tester', edgeTags, parentHash)
}

describe('Plugin', () => {
  describe('kafkajs', function () {
    this.timeout(10000)

    afterEach(() => {
      return agent.close({ ritmReset: false })
    })

    withVersions('kafkajs', 'kafkajs', (version) => {
      let kafka
      let admin
      let tracer
      let Kafka
      let clusterIdAvailable
      let expectedProducerHash
      let expectedConsumerHash
      let testTopic

      describe('data stream monitoring', () => {
        const messages = [{ key: 'key1', value: 'test2' }]

        beforeEach(async () => {
          process.env.DD_DATA_STREAMS_ENABLED = 'true'
          tracer = require('../../../')
          await agent.load('kafkajs')
          const lib = require(`../../../../../versions/kafkajs@${version}`).get()
          Kafka = lib.Kafka
          kafka = new Kafka({
            clientId: `kafkajs-test-${version}`,
            brokers: ['127.0.0.1:9092'],
            logLevel: lib.logLevel.WARN
          })
          testTopic = `test-topic-${randomUUID()}`
          admin = kafka.admin()
          await admin.createTopics({
            topics: [{
              topic: testTopic,
              numPartitions: 1,
              replicationFactor: 1
            }]
          })
          clusterIdAvailable = semver.intersects(version, '>=1.13')
          expectedProducerHash = getDsmPathwayHash(testTopic, clusterIdAvailable, true, ENTRY_PARENT_HASH)
          expectedConsumerHash = getDsmPathwayHash(testTopic, clusterIdAvailable, false, expectedProducerHash)
        })

        describe('checkpoints', () => {
          let consumer
          let setDataStreamsContextSpy

          beforeEach(async () => {
            tracer.init()
            tracer.use('kafkajs', { dsmEnabled: true })
            consumer = kafka.consumer({ groupId: 'test-group' })
            await consumer.connect()
            await consumer.subscribe({ topic: testTopic })
            setDataStreamsContextSpy = sinon.spy(DataStreamsContext, 'setDataStreamsContext')
          })

          afterEach(async () => {
            setDataStreamsContextSpy.restore()
            await consumer.disconnect()
          })

          it('Should set a checkpoint on produce', async () => {
            const messages = [{ key: 'consumerDSM1', value: 'test2' }]
            await sendMessages(kafka, testTopic, messages)
            expect(setDataStreamsContextSpy.args[0][0].hash).to.equal(expectedProducerHash)
          })

          it('Should set a checkpoint on consume (eachMessage)', async () => {
            const runArgs = []
            await consumer.run({
              eachMessage: async () => {
                runArgs.push(setDataStreamsContextSpy.lastCall.args[0])
              }
            })
            await sendMessages(kafka, testTopic, messages)
            await consumer.disconnect()
            for (const runArg of runArgs) {
              expect(runArg.hash).to.equal(expectedConsumerHash)
            }
          })

          it('Should set a checkpoint on consume (eachBatch)', async () => {
            const runArgs = []
            await consumer.run({
              eachBatch: async () => {
                runArgs.push(setDataStreamsContextSpy.lastCall.args[0])
              }
            })
            await sendMessages(kafka, testTopic, messages)
            await consumer.disconnect()
            for (const runArg of runArgs) {
              expect(runArg.hash).to.equal(expectedConsumerHash)
            }
          })

          it('Should set a message payload size when producing a message', async () => {
            const messages = [{ key: 'key1', value: 'test2' }]
            if (DataStreamsProcessor.prototype.recordCheckpoint.isSinonProxy) {
              DataStreamsProcessor.prototype.recordCheckpoint.restore()
            }
            const recordCheckpointSpy = sinon.spy(DataStreamsProcessor.prototype, 'recordCheckpoint')
            await sendMessages(kafka, testTopic, messages)
            expect(recordCheckpointSpy.args[0][0].hasOwnProperty('payloadSize'))
            recordCheckpointSpy.restore()
          })

          it('Should set a message payload size when consuming a message', async () => {
            const messages = [{ key: 'key1', value: 'test2' }]
            if (DataStreamsProcessor.prototype.recordCheckpoint.isSinonProxy) {
              DataStreamsProcessor.prototype.recordCheckpoint.restore()
            }
            const recordCheckpointSpy = sinon.spy(DataStreamsProcessor.prototype, 'recordCheckpoint')
            await sendMessages(kafka, testTopic, messages)
            await consumer.run({
              eachMessage: async () => {
                expect(recordCheckpointSpy.args[0][0].hasOwnProperty('payloadSize'))
                recordCheckpointSpy.restore()
              }
            })
          })
        })

        describe('backlogs', () => {
          let consumer
          let setOffsetSpy

          beforeEach(async () => {
            tracer.init()
            tracer.use('kafkajs', { dsmEnabled: true })
            consumer = kafka.consumer({ groupId: 'test-group' })
            await consumer.connect()
            await consumer.subscribe({ topic: testTopic })
            setOffsetSpy = sinon.spy(tracer._tracer._dataStreamsProcessor, 'setOffset')
          })

          afterEach(async () => {
            setOffsetSpy.restore()
            await consumer.disconnect()
          })

          if (semver.intersects(version, '>=1.10')) {
            it('Should add backlog on consumer explicit commit', async () => {
              // Send a message, consume it, and record the last consumed offset
              let commitMeta
              const deferred = {}
              deferred.promise = new Promise((resolve, reject) => {
                deferred.resolve = resolve
                deferred.reject = reject
              })
              await consumer.run({
                eachMessage: async payload => {
                  const { topic, partition, message } = payload
                  commitMeta = {
                    topic,
                    partition,
                    offset: Number(message.offset)
                  }
                  deferred.resolve()
                },
                autoCommit: false
              })
              await sendMessages(kafka, testTopic, messages)
              await deferred.promise
              await consumer.disconnect() // Flush ongoing `eachMessage` calls
              for (const call of setOffsetSpy.getCalls()) {
                expect(call.args[0]).to.not.have.property('type', 'kafka_commit')
              }

              /**
               * No choice but to reinitialize everything, because the only way to flush eachMessage
               * calls is to disconnect.
               */
              consumer.connect()
              await sendMessages(kafka, testTopic, messages)
              await consumer.run({ eachMessage: async () => {}, autoCommit: false })
              setOffsetSpy.resetHistory()
              await consumer.commitOffsets([commitMeta])
              await consumer.disconnect()

              // Check our work
              const runArg = setOffsetSpy.lastCall.args[0]
              expect(setOffsetSpy).to.be.calledOnce
              expect(runArg).to.have.property('offset', commitMeta.offset)
              expect(runArg).to.have.property('partition', commitMeta.partition)
              expect(runArg).to.have.property('topic', commitMeta.topic)
              expect(runArg).to.have.property('type', 'kafka_commit')
              expect(runArg).to.have.property('consumer_group', 'test-group')
            })
          }

          it('Should add backlog on producer response', async () => {
            await sendMessages(kafka, testTopic, messages)
            expect(setOffsetSpy).to.be.calledOnce
            const { topic } = setOffsetSpy.lastCall.args[0]
            expect(topic).to.equal(testTopic)
          })
        })
      })
    })
  })
})

async function sendMessages (kafka, topic, messages) {
  const producer = kafka.producer()
  await producer.connect()
  await producer.send({
    topic,
    messages
  })
  await producer.disconnect()
}

