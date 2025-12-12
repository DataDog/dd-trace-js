'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const { randomUUID } = require('node:crypto')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const DataStreamsContext = require('../../dd-trace/src/datastreams/context')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH, DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')

const getDsmPathwayHash = (testTopic, isProducer, parentHash) => {
  let edgeTags
  if (isProducer) {
    edgeTags = ['direction:out', 'topic:' + testTopic, 'type:kafka']
  } else {
    edgeTags = ['direction:in', 'group:test-group-confluent', 'topic:' + testTopic, 'type:kafka']
  }

  edgeTags.sort()
  return computePathwayHash('test', 'tester', edgeTags, parentHash)
}

describe('Plugin', () => {
  const module = '@confluentinc/kafka-javascript'
  const groupId = 'test-group-confluent'

  describe('confluentinc-kafka-javascript', function () {
    this.timeout(30000)

    afterEach(() => {
      return agent.close({ ritmReset: false })
    })

    withVersions('confluentinc-kafka-javascript', module, (version) => {
      let kafka
      let admin
      let tracer
      let Kafka
      let ConfluentKafka
      let messages
      let nativeApi
      let testTopic

      describe('data stream monitoring', () => {
        let consumer
        let expectedProducerHash
        let expectedConsumerHash

        beforeEach(async () => {
          messages = [{ key: 'key1', value: 'test2' }]

          process.env.DD_DATA_STREAMS_ENABLED = 'true'
          tracer = require('../../dd-trace')
          await agent.load('confluentinc-kafka-javascript')
          const lib = require(`../../../versions/${module}@${version}`).get()

          // Store the module for later use
          nativeApi = lib

          // Setup for the KafkaJS wrapper tests
          ConfluentKafka = lib.KafkaJS
          Kafka = ConfluentKafka.Kafka
          kafka = new Kafka({
            kafkaJS: {
              clientId: `kafkajs-test-${version}`,
              brokers: ['127.0.0.1:9092'],
              logLevel: ConfluentKafka.logLevel.WARN
            }
          })
          testTopic = `test-topic-${randomUUID()}`
          admin = kafka.admin()
          await admin.connect()
          await admin.createTopics({
            topics: [{
              topic: testTopic,
              numPartitions: 1,
              replicationFactor: 1
            }]
          })
          await admin.disconnect()

          consumer = kafka.consumer({
            kafkaJS: { groupId, fromBeginning: true }
          })
          await consumer.connect()
          await consumer.subscribe({ topic: testTopic })
        })

        beforeEach(() => {
          expectedProducerHash = getDsmPathwayHash(testTopic, true, ENTRY_PARENT_HASH)
          expectedConsumerHash = getDsmPathwayHash(testTopic, false, expectedProducerHash)
        })

        afterEach(async () => {
          await consumer.disconnect()
        })

        describe('checkpoints', () => {
          let setDataStreamsContextSpy

          beforeEach(() => {
            setDataStreamsContextSpy = sinon.spy(DataStreamsContext, 'setDataStreamsContext')
          })

          afterEach(async () => {
            setDataStreamsContextSpy.restore()
          })

          it('Should set a checkpoint on produce', async () => {
            const messages = [{ key: 'consumerDSM1', value: 'test2' }]
            await sendMessages(kafka, testTopic, messages)
            expect(setDataStreamsContextSpy.args[0][0].hash).to.equal(expectedProducerHash)
          })

          it('Should set a checkpoint on consume (eachMessage)', async () => {
            const runArgs = []
            let consumerReceiveMessagePromise
            await consumer.run({
              eachMessage: async () => {
                runArgs.push(setDataStreamsContextSpy.lastCall.args[0])
                consumerReceiveMessagePromise = Promise.resolve()
              }
            })
            await sendMessages(kafka, testTopic, messages).then(
              async () => await consumerReceiveMessagePromise
            )

            for (const runArg of runArgs) {
              expect(runArg.hash).to.equal(expectedConsumerHash)
            }
          })

          it('Should set a checkpoint on consume (eachBatch)', async () => {
            const runArgs = []
            let consumerReceiveMessagePromise
            await consumer.run({
              eachBatch: async () => {
                runArgs.push(setDataStreamsContextSpy.lastCall.args[0])
                consumerReceiveMessagePromise = Promise.resolve()
              }
            })
            await sendMessages(kafka, testTopic, messages).then(
              async () => await consumerReceiveMessagePromise
            )
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
            let consumerReceiveMessagePromise
            await consumer.run({
              eachMessage: async () => {
                expect(recordCheckpointSpy.args[0][0].hasOwnProperty('payloadSize'))
                recordCheckpointSpy.restore()
                consumerReceiveMessagePromise = Promise.resolve()
              }
            })
            await sendMessages(kafka, testTopic, messages).then(
              async () => await consumerReceiveMessagePromise
            )
          })
        })

        describe('backlogs', () => {
          let setOffsetSpy

          beforeEach(() => {
            setOffsetSpy = sinon.spy(tracer._tracer._dataStreamsProcessor, 'setOffset')
          })

          afterEach(() => {
            setOffsetSpy.restore()
          })

          it('Should add backlog on consumer explicit commit', async () => {
            // Send a message, consume it, and record the last consumed offset
            let commitMeta

            let messageProcessedResolve
            const messageProcessedPromise = new Promise(resolve => {
              messageProcessedResolve = resolve
            })

            const consumerRunPromise = consumer.run({
              eachMessage: async payload => {
                const { topic, partition, message } = payload
                commitMeta = {
                  topic,
                  partition,
                  offset: Number(message.offset)
                }
                messageProcessedResolve()
              }
            })

            await consumerRunPromise

            // wait for the message to be processed before continuing
            await sendMessages(kafka, testTopic, messages)
            await messageProcessedPromise
            await consumer.disconnect()

            for (const call of setOffsetSpy.getCalls()) {
              expect(call.args[0]).to.not.have.property('type', 'kafka_commit')
            }

            const newConsumer = kafka.consumer({
              kafkaJS: { groupId, fromBeginning: true, autoCommit: false }
            })
            await newConsumer.connect()
            await sendMessages(kafka, testTopic, [{ key: 'key1', value: 'test2' }])
            await newConsumer.run({
              eachMessage: async () => {
                await newConsumer.disconnect()
              }
            })
            setOffsetSpy.resetHistory()
            await newConsumer.commitOffsets()

            // Check our work
            const runArg = setOffsetSpy.lastCall.args[0]
            expect(runArg).to.have.property('offset', commitMeta.offset)
            expect(runArg).to.have.property('partition', commitMeta.partition)
            expect(runArg).to.have.property('topic', commitMeta.topic)
            expect(runArg).to.have.property('type', 'kafka_commit')
            expect(runArg).to.have.property('consumer_group', groupId)
          })

          it('Should add backlog on producer response', async () => {
            await sendMessages(kafka, testTopic, messages)
            expect(setOffsetSpy).to.be.calledOnce
            const { topic } = setOffsetSpy.lastCall.args[0]
            expect(topic).to.equal(testTopic)
          })
        })

        describe('when using a kafka broker version that does not support message headers', () => {
          class KafkaJSError extends Error {
            constructor (message) {
              super(message)
              this.name = 'KafkaJSError'
              this.type = 'ERR_UNKNOWN'
            }
          }
          let error
          let producer
          let produceStub

          beforeEach(async () => {
            // simulate a kafka error for the broker version not supporting message headers
            error = new KafkaJSError()
            error.message = 'Simulated KafkaJSError ERR_UNKNOWN from Producer.produce stub'
            producer = kafka.producer()
            await producer.connect()

            // Spy on the produce method from the native library before it gets wrapped
            produceStub = sinon.stub(nativeApi.Producer.prototype, 'produce')
              .callsFake((topic, partition, message, key) => {
                throw error
              })
          })

          afterEach(async () => {
            produceStub.restore()
            await producer.disconnect()
          })

          it('should hit an error for the first send and not inject headers in later sends', async () => {
            const testMessages = [{ key: 'key1', value: 'test1' }]
            const testMessages2 = [{ key: 'key2', value: 'test2' }]

            try {
              await producer.send({ topic: testTopic, messages: testMessages })
              expect.fail('First producer.send() should have thrown an error')
            } catch (e) {
              expect(e).to.equal(error)
            }
            // Verify headers were injected in the first attempt
            expect(testMessages[0].headers[0]).to.have.property('x-datadog-trace-id')

            // restore the stub to allow the next send to succeed
            produceStub.restore()

            const result = await producer.send({ topic: testTopic, messages: testMessages2 })
            expect(testMessages2[0].headers).to.be.null
            expect(result).to.not.be.undefined
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
