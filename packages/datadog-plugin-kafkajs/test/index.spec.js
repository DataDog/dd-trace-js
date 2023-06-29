'use strict'

const { expect } = require('chai')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const Hash = require('../src/hash')
const sinon = require('sinon')

const DEFAULT_PATHWAY_HASH = Buffer.from('e858292fd15a41e4', 'hex')
const DEFAULT_PATHWAY_CTX = Buffer.from('e073ca23a5577149a0a8879de561a0a8879de561', 'hex')
const DEFAULT_TIMESTAMP = Number(new Date('2023-04-20T16:20:00.000Z'))

const namingSchema = require('./naming')

describe('Plugin', () => {
  describe('kafkajs', function () {
    this.timeout(10000) // TODO: remove when new internal trace has landed
    afterEach(() => {
      return agent.close({ ritmReset: false })
    })
    withVersions('kafkajs', 'kafkajs', (version) => {
      const testTopic = 'test-topic'
      let kafka
      let tracer
      describe('without configuration', () => {
        beforeEach(async () => {
          tracer = require('../../dd-trace')
          await agent.load('kafkajs')
          const {
            Kafka
          } = require(`../../../versions/kafkajs@${version}`).get()
          kafka = new Kafka({
            clientId: `kafkajs-test-${version}`,
            brokers: ['127.0.0.1:9092']
          })
        })
        describe('producer', () => {
          it('should be instrumented', async () => {
            const messages = [{ key: 'producer1', value: 'test2' }]
            const expectedSpanPromise = expectSpanWithDefaults({
              name: namingSchema.send.opName,
              service: namingSchema.send.serviceName,
              meta: {
                'span.kind': 'producer',
                'component': 'kafkajs'
              },
              metrics: {
                'kafka.batch_size': messages.length
              },
              resource: testTopic,
              error: 0

            })

            await sendMessages(kafka, testTopic, messages)

            return expectedSpanPromise
          })

          it('should be instrumented w/ error', async () => {
            const producer = kafka.producer()
            const resourceName = namingSchema.send.opName

            let error

            const expectedSpanPromise = agent.use(traces => {
              const span = traces[0][0]

              expect(span).to.include({
                name: resourceName,
                service: namingSchema.send.serviceName,
                resource: resourceName,
                error: 1
              })

              expect(span.meta).to.include({
                [ERROR_TYPE]: error.name,
                [ERROR_MESSAGE]: error.message,
                [ERROR_STACK]: error.stack,
                'component': 'kafkajs'
              })
            })

            try {
              await producer.connect()
              await producer.send({
                testTopic,
                messages: 'Oh no!'
              })
            } catch (e) {
              error = e
              await producer.disconnect()
              return expectedSpanPromise
            }
          })

          const messages = [{ key: 'producer1', value: 'test2' }]
          withNamingSchema(
            async () => sendMessages(kafka, testTopic, messages),
            () => namingSchema.send.opName,
            () => namingSchema.send.serviceName
          )
        })

        describe('producer data stream monitoring', () => {
          const sandbox = sinon.createSandbox()
          before(() => {
            // for DSM propagation test
            sandbox.spy(Hash, 'decodePathwayContext')
            sandbox.spy(Hash, 'encodePathwayContext')
            sinon.replace(Date, 'now', () => DEFAULT_TIMESTAMP)
          })
          after(() => {
            sandbox.restore()
            sinon.restore()
          })

          beforeEach(() => {
            tracer.init()
            tracer.use('kafkajs', { dsmEnabled: true })
          })

          it('should set root dsm checkpoint when there is no consumer parent span', async () => {
            const messages = [{ key: 'producerDSM', value: 'test2' }]
            await sendMessages(kafka, testTopic, messages)
            const pathwayCtxArgs = Hash.encodePathwayContext.getCall(-1).args
            const pathwayHash = pathwayCtxArgs[0]
            const originTimestamp = pathwayCtxArgs[1]
            const currentTimestamp = pathwayCtxArgs[2]
            expect(pathwayHash.length).to.equal(DEFAULT_PATHWAY_HASH.length)
            for (let i = 0; i < DEFAULT_PATHWAY_HASH.length; i++) {
              expect(pathwayHash[i]).to.equal(DEFAULT_PATHWAY_HASH[i])
            }
            expect(originTimestamp).to.equal(DEFAULT_TIMESTAMP)
            expect(currentTimestamp).to.equal(DEFAULT_TIMESTAMP)
          })

          it('should receive dsm header propagation from consumer span', async () => {
            const messages = [{ key: 'producerDSM2', value: 'test2' }]
            const scope = tracer.scope()
            const childOf = tracer.startSpan('fake consumer parent span', {
              tags: {
                name: 'kafka.consume',
                service: 'test-kafka',
                meta: {
                  'span.kind': 'consumer',
                  'component': 'kafkajs'
                },
                metrics: {
                  'dd-pathway-ctx': DEFAULT_PATHWAY_CTX
                },
                resource: testTopic,
                error: 0,
                type: 'worker'
              }
            })
            await scope.activate(childOf, async () => {
              await sendMessages(kafka, testTopic, messages)
              const propagatedCtx = Hash.decodePathwayContext.getCall(-1).args[0]
              expect(propagatedCtx.length).to.equal(DEFAULT_PATHWAY_CTX.length)
              for (let i = 0; i < DEFAULT_PATHWAY_CTX.length; i++) {
                expect(DEFAULT_PATHWAY_CTX[i]).to.equal(propagatedCtx[i])
              }
            })
          })
        })
        describe('consumer', () => {
          let consumer
          beforeEach(async () => {
            consumer = kafka.consumer({ groupId: 'test-group' })
            await consumer.connect()
            await consumer.subscribe({ topic: testTopic })
          })

          afterEach(async () => {
            await consumer.disconnect()
          })

          it('should be instrumented', async () => {
            const messages = [{ key: 'consumer1', value: 'test2' }]
            const expectedSpanPromise = expectSpanWithDefaults({
              name: namingSchema.receive.opName,
              service: namingSchema.receive.serviceName,
              meta: {
                'span.kind': 'consumer',
                'component': 'kafkajs'
              },
              resource: testTopic,
              error: 0,
              type: 'worker'
            })

            await consumer.run({
              eachMessage: () => {}
            })
            await sendMessages(kafka, testTopic, messages)

            return expectedSpanPromise
          })

          it('should run the consumer in the context of the consumer span', done => {
            const messages = [{ key: 'consumer2', value: 'test2' }]
            const firstSpan = tracer.scope().active()
            let eachMessage = async ({ topic, partition, message }) => {
              const currentSpan = tracer.scope().active()
              try {
                expect(currentSpan).to.not.equal(firstSpan)
                expect(currentSpan.context()._name).to.equal(namingSchema.receive.opName)
                done()
              } catch (e) {
                done(e)
              } finally {
                eachMessage = () => {} // avoid being called for each message
              }
            }

            consumer.run({
              eachMessage: (...args) => eachMessage(...args) })
              .then(() => sendMessages(kafka, testTopic, messages))
              .catch(done)
          })

          it('should be instrumented w/ error', async () => {
            const messages = [{ key: 'consumer3', value: 'test2' }]
            const fakeError = new Error('Oh No!')
            const expectedSpanPromise = expectSpanWithDefaults({
              name: namingSchema.receive.opName,
              service: namingSchema.receive.serviceName,
              meta: {
                [ERROR_TYPE]: fakeError.name,
                [ERROR_MESSAGE]: fakeError.message,
                [ERROR_STACK]: fakeError.stack,
                'component': 'kafkajs'
              },
              resource: testTopic,
              error: 1,
              type: 'worker'

            })

            await consumer.subscribe({ topic: testTopic, fromBeginning: true })
            await consumer.run({
              eachMessage: async ({ topic, partition, message }) => {
                throw fakeError
              }
            })
            await sendMessages(kafka, testTopic, messages)

            return expectedSpanPromise
          })

          it('should run constructor even if no eachMessage supplied', (done) => {
            const messages = [{ key: 'consumer4', value: 'test2' }]
            let eachBatch = async ({ batch }) => {
              try {
                expect(batch.isEmpty()).to.be.false
                done()
              } catch (e) {
                done(e)
              } finally {
                eachBatch = () => {} // avoid being called for each message
              }
            }

            const runResult = consumer.run({
              eachBatch: (...args) => eachBatch(...args)
            })

            if (!runResult || !runResult.then) {
              throw new Error('Consumer.run returned invalid result')
            }

            runResult
              .then(() => sendMessages(kafka, testTopic, messages))
              .catch(done)
          })

          const messages = [{ key: 'consumer4', value: 'test2' }]
          withNamingSchema(
            async () => {
              await consumer.run({ eachMessage: () => {} })
              await sendMessages(kafka, testTopic, messages)
            },
            () => namingSchema.send.opName,
            () => namingSchema.send.serviceName
          )
        })

        describe('consumer data stream monitoring', () => {
          const sandbox = sinon.createSandbox()
          let consumer
          beforeEach(async () => {
            tracer.init()
            tracer.use('kafkajs', { dsmEnabled: true })
            consumer = kafka.consumer({ groupId: 'test-group' })
            sandbox.spy(Hash, 'encodePathwayContext')
            sinon.replace(Date, 'now', () => DEFAULT_TIMESTAMP)
            await consumer.connect()
            await consumer.subscribe({ topic: testTopic })
          })

          afterEach(async () => {
            await consumer.disconnect()
            sandbox.restore()
            sinon.restore()
          })

          it('should set root dsm checkpoint when there is no parent node', async () => {
            const expectedPathwayHash = Buffer.from('e858292fd15a41e4', 'hex')
            const messages = [{ key: 'consumerDSM1', value: 'test2' }]
            await sendMessages(kafka, testTopic, messages)
            const pathwayCtxArgs = Hash.encodePathwayContext.getCall(-1).args
            const pathwayHash = pathwayCtxArgs[0]
            const originTimestamp = pathwayCtxArgs[1]
            const currentTimestamp = pathwayCtxArgs[2]
            expect(pathwayHash.length).to.equal(expectedPathwayHash.length)
            for (let i = 0; i < expectedPathwayHash.length; i++) {
              expect(pathwayHash[i]).to.equal(expectedPathwayHash[i])
            }
            expect(originTimestamp).to.equal(DEFAULT_TIMESTAMP)
            expect(currentTimestamp).to.equal(DEFAULT_TIMESTAMP)
          })

          it('should propagate context', (done) => {
            const messages = [{ key: 'consumerDSM2', value: 'test2' }]
            const expectedPathwayCtx = Buffer.from('16f60748b780b322a0a8879de56180aeb9f7f361', 'hex')
            const scope = tracer.scope()
            const span = tracer.startSpan('consumer span', {
              tags: {
                name: 'kafka.consume',
                service: 'test-kafka',
                meta: {
                  'span.kind': 'consumer',
                  'component': 'kafkajs'
                },
                metrics: {
                  'dd-pathway-ctx': DEFAULT_PATHWAY_CTX
                },
                resource: testTopic,
                error: 0,
                type: 'worker'
              }
            })
            scope.activate(span, async () => {
              consumer.run({
                eachMessage: async ({ topic, partition, message, heartbeat, pause }) => {
                  if (span.context().toTraceId() !== tracer.scope().active().context().toTraceId()) return
                  const propagatedCtx = message.headers['dd-pathway-ctx']
                  expect(propagatedCtx.length).to.equal(expectedPathwayCtx.length)
                  for (let i = 0; i < expectedPathwayCtx.length; i++) {
                    expect(expectedPathwayCtx[i]).to.equal(propagatedCtx[i])
                  }
                  done()
                } })
                .then(() => sendMessages(kafka, testTopic, messages))
                .catch(done)
            })
          })
        })
      })
    })
  })
})

function expectSpanWithDefaults (expected) {
  const { service } = expected.meta
  expected = withDefaults({
    name: expected.name,
    service,
    meta: expected.meta
  }, expected)
  return expectSomeSpan(agent, expected)
}

async function sendMessages (kafka, topic, messages) {
  const producer = kafka.producer()
  await producer.connect()
  await producer.send({
    topic,
    messages
  })
  await producer.disconnect()
}
