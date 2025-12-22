'use strict'

const assert = require('node:assert/strict')
const sinon = require('sinon')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const id = require('../../dd-trace/src/id')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')

const { expectedSchema, rawExpectedSchema } = require('./naming')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { DataStreamsProcessor, ENTRY_PARENT_HASH } = require('../../dd-trace/src/datastreams/processor')

// The roundtrip to the pubsub emulator takes time. Sometimes a *long* time.
const TIMEOUT = 30000
const dsmTopicName = 'dsm-topic'

describe('Plugin', () => {
  let tracer

  describe('google-cloud-pubsub', function () {
    this.timeout(TIMEOUT)

    before(() => {
      process.env.PUBSUB_EMULATOR_HOST = 'localhost:8081'
      process.env.DD_DATA_STREAMS_ENABLED = 'true'
      process.env.K_SERVICE = 'test-service'
    })

    after(() => {
      delete process.env.PUBSUB_EMULATOR_HOST
      delete process.env.DD_DATA_STREAMS_ENABLED
      delete process.env.K_SERVICE
    })

    afterEach(() => {
      return agent.close({ ritmReset: false })
    })
    withVersions('google-cloud-pubsub', '@google-cloud/pubsub', version => {
      let pubsub
      let project
      let topicName
      let resource
      let v1
      let gax

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load('google-cloud-pubsub', { dsmEnabled: false }, { flushMinSpans: 1 })
        })

        beforeEach(() => {
          tracer = require('../../dd-trace')
          gax = require('../../../versions/google-gax@3.5.7').get()
          const lib = require(`../../../versions/@google-cloud/pubsub@${version}`).get()
          project = getProjectId()
          topicName = getTopic()
          resource = `projects/${project}/topics/${topicName}`
          v1 = lib.v1
          pubsub = new lib.PubSub({ projectId: project })
        })

        describe('createTopic', () => {
          withNamingSchema(
            async () => pubsub.createTopic(topicName),
            rawExpectedSchema.controlPlane
          )

          it('should be instrumented', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.controlPlane.opName,
              service: expectedSchema.controlPlane.serviceName,
              meta: {
                'pubsub.method': 'createTopic',
                'span.kind': 'client',
                component: 'google-cloud-pubsub'
              }
            })
            await pubsub.createTopic(topicName)
            return expectedSpanPromise
          })

          it('should be instrumented when using the internal API', async () => {
            const publisher = new v1.PublisherClient({
              grpc: gax.grpc,
              projectId: project,
              servicePath: 'localhost',
              port: 8081,
              sslCreds: gax.grpc.credentials.createInsecure()
            }, gax)

            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.controlPlane.opName,
              service: expectedSchema.controlPlane.serviceName,
              meta: {
                'pubsub.method': 'createTopic',
                'span.kind': 'client',
                component: 'google-cloud-pubsub'
              }
            })
            const name = `projects/${project}/topics/${topicName}`
            const promise = publisher.createTopic({ name })
            await promise

            return expectedSpanPromise
          })

          it('should be instrumented w/ error', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.controlPlane.opName,
              service: expectedSchema.controlPlane.serviceName,
              error: 1,
              meta: {
                'pubsub.method': 'createTopic',
                component: 'google-cloud-pubsub'
              }
            })
            const publisher = new v1.PublisherClient({
              projectId: project,
              grpc: gax.grpc,
              servicePath: 'localhost',
              port: 8081,
              sslCreds: gax.grpc.credentials.createInsecure()
            }, gax)
            const name = `projects/${project}/topics/${topicName}`
            try {
              // This should fail because the topic already exists or similar error
              await publisher.createTopic({ name })
              await publisher.createTopic({ name }) // Try to create twice to force error
            } catch (e) {
            // this is just to prevent mocha from crashing
            }
            return expectedSpanPromise
          })

          it('should propagate context', () => {
            const firstSpan = tracer.scope().active()
            return pubsub.createTopic(topicName)
              .then(() => {
                assert.strictEqual(tracer.scope().active(), firstSpan)
              })
          })
        })

        describe('publish', () => {
          it('should be instrumented', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.send.opName,
              service: expectedSchema.send.serviceName,
              meta: {
                'pubsub.topic': resource,
                'pubsub.method': 'publish',
                'span.kind': 'producer',
                component: 'google-cloud-pubsub'
              }
            })
            const [topic] = await pubsub.createTopic(topicName)
            await publish(topic, { data: Buffer.from('hello') })
            return expectedSpanPromise
          })

          it('should propagate context', () => {
            const firstSpan = tracer.scope().active()
            return pubsub.createTopic(topicName)
              .then(([topic]) =>
                publish(topic, { data: Buffer.from('hello') })
              )
              .then(() => {
                assert.strictEqual(tracer.scope().active(), firstSpan)
              })
          })

          withNamingSchema(
            async () => {
              const [topic] = await pubsub.createTopic(topicName)
              await publish(topic, { data: Buffer.from('hello') })
            },
            rawExpectedSchema.send
          )
        })

        describe('onmessage', () => {
          it('should be instrumented', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.receive.opName,
              service: expectedSchema.receive.serviceName,
              type: 'worker',
              meta: {
                component: 'google-cloud-pubsub',
                'span.kind': 'consumer',
                'pubsub.topic': resource
              },
              metrics: {
                'pubsub.ack': 1
              }
            })
            const [topic] = await pubsub.createTopic(topicName)
            const [sub] = await topic.createSubscription('foo')
            sub.on('message', msg => msg.ack())
            await publish(topic, { data: Buffer.from('hello') })
            return expectedSpanPromise
          })

          it('should give the current span a parentId from the sender', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.receive.opName,
              service: expectedSchema.receive.serviceName,
              type: 'worker',
              meta: {
                component: 'google-cloud-pubsub',
                'span.kind': 'consumer',
                'pubsub.topic': resource
              }
            })
            const [topic] = await pubsub.createTopic(topicName)
            const [sub] = await topic.createSubscription('foo')
            sub.on('message', msg => {
              const activeSpan = tracer.scope().active()
              if (activeSpan) {
                const receiverSpanContext = activeSpan._spanContext
                assert.ok(typeof receiverSpanContext._parentId === 'object' && receiverSpanContext._parentId !== null)
              }
              msg.ack()
            })
            await publish(topic, { data: Buffer.from('hello') })
            return expectedSpanPromise
          })

          it('should be instrumented w/ error', async () => {
            const error = new Error('bad')
            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.receive.opName,
              service: expectedSchema.receive.serviceName,
              type: 'worker',
              error: 1,
              meta: {
                [ERROR_MESSAGE]: error.message,
                [ERROR_TYPE]: error.name,
                [ERROR_STACK]: error.stack,
                component: 'google-cloud-pubsub',
                'span.kind': 'consumer',
                'pubsub.topic': resource
              }
            })
            const [topic] = await pubsub.createTopic(topicName)
            const [sub] = await topic.createSubscription('foo')
            const emit = sub.emit
            sub.emit = function emitWrapped (name) {
              let err

              try {
                return emit.apply(this, arguments)
              } catch (e) {
                err = e
              } finally {
                if (name === 'message') {
                  assert.strictEqual(err, error)
                }
              }
            }
            sub.on('message', msg => {
              try {
                throw error
              } finally {
                msg.ack()
              }
            })
            await publish(topic, { data: Buffer.from('hello') })
            return expectedSpanPromise
          })

          withNamingSchema(
            async (config) => {
              const [topic] = await pubsub.createTopic(topicName)
              const [sub] = await topic.createSubscription('foo')
              sub.on('message', msg => msg.ack())
              await publish(topic, { data: Buffer.from('hello') })
            },
            rawExpectedSchema.receive,
            {
              selectSpan: (traces) => {
                for (const trace of traces) {
                  for (const span of trace) {
                    if (span.type === 'worker') {
                      return span
                    }
                  }
                }
                return undefined
              }
            }
          )
        })

        describe('when disabled', () => {
          beforeEach(() => {
            tracer.use('google-cloud-pubsub', false)
          })

          afterEach(() => {
            tracer.use('google-cloud-pubsub', true)
          })

          it('should work normally', async () => {
            await pubsub.createTopic(topicName)
          })
        })

        it('should handle manual subscription close', async () => {
          const [topic] = await pubsub.createTopic(topicName)
          const [sub] = await topic.createSubscription('foo')

          // message handler takes a while, subscription is closed while it's still running
          sub.on('message', msg => {
            setTimeout(() => { msg.ack() }, 2000)
          })

          await publish(topic, { data: Buffer.from('hello') })

          setTimeout(() => { sub.close() }, 500)

          return new Promise((resolve) => {
            sub.on('close', resolve)
          })
        })
      })

      describe('with configuration', () => {
        beforeEach(() => {
          return agent.load('google-cloud-pubsub', {
            service: 'a_test_service',
            dsmEnabled: false
          })
        })

        beforeEach(() => {
          tracer = require('../../dd-trace')
          const { PubSub } = require(`../../../versions/@google-cloud/pubsub@${version}`).get()
          project = getProjectId()
          topicName = getTopic()
          resource = `projects/${project}/topics/${topicName}`
          pubsub = new PubSub({ projectId: project })
        })

        describe('createTopic', () => {
          it('should be instrumented', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.controlPlane.opName,
              service: 'a_test_service',
              meta: { 'pubsub.method': 'createTopic' }
            })
            await pubsub.createTopic(topicName)
            return expectedSpanPromise
          })
        })
      })

      describe('data stream monitoring', () => {
        let dsmTopic
        let sub
        let consume
        let expectedProducerHash
        let expectedConsumerHash

        beforeEach(() => {
          return agent.load('google-cloud-pubsub', {
            dsmEnabled: true
          })
        })

        before(async () => {
          const { PubSub } = require(`../../../versions/@google-cloud/pubsub@${version}`).get()
          project = getProjectId()
          resource = `projects/${project}/topics/${dsmTopicName}`
          pubsub = new PubSub({ projectId: project })
          tracer.use('google-cloud-pubsub', { dsmEnabled: true })

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

        describe('garbage collection and memory leaks', function () {
          // GC tests need --expose-gc flag
          if (typeof global.gc !== 'function') {
            return it.skip('requires --expose-gc flag')
          }

          it('should clean up WeakMap entries when messages are garbage collected', async function () {
            this.timeout(10000)

            // Create a weak reference to track if message is GC'd
            let messageWasCollected = false
            const finalizationRegistry = new FinalizationRegistry(() => {
              messageWasCollected = true
            })

            // Use unique topic name for GC test
            const gcTopicName = `gc-test-${Date.now()}`

            // Publish and consume without acknowledging
            await (async () => {
              const [topic] = await pubsub.createTopic(gcTopicName)
              const [subscription] = await topic.createSubscription('gc-test-sub')

              let messageReceived = false
              subscription.on('message', (message) => {
                // Register the message for GC tracking
                finalizationRegistry.register(message, 'test-message')
                messageReceived = true
                // DON'T call message.ack() - this tests the GC cleanup path
              })

              await publish(topic, { data: Buffer.from('gc test message') })

              // Wait for message to be received
              await new Promise((resolve) => {
                const checkInterval = setInterval(() => {
                  if (messageReceived) {
                    clearInterval(checkInterval)
                    resolve()
                  }
                }, 100)
              })

              // Close subscription to release references
              subscription.close()
            })()

            // Force garbage collection multiple times
            global.gc()
            await new Promise(resolve => setTimeout(resolve, 100))
            global.gc()
            await new Promise(resolve => setTimeout(resolve, 100))
            global.gc()

            // Wait a bit for FinalizationRegistry callback
            await new Promise(resolve => setTimeout(resolve, 500))

            // Verify the message was garbage collected
            // This proves WeakMap doesn't prevent GC
            assert.ok(messageWasCollected, 'Message should be garbage collected even without ack()')
          })

          it('should not leak memory with many messages without ack', async function () {
            this.timeout(20000) // Increase timeout for older Pub/Sub versions

            const initialMemory = process.memoryUsage().heapUsed

            // Use unique topic name for leak test
            const leakTopicName = `leak-test-${Date.now()}`
            const [topic] = await pubsub.createTopic(leakTopicName)
            const [subscription] = await topic.createSubscription('leak-test-sub')

            let messagesReceived = 0
            const targetMessages = 50 // Reduce from 100 to 50 for faster test

            subscription.on('message', (message) => {
              messagesReceived++
              // DON'T acknowledge - test that WeakMap doesn't leak
            })

            // Send many messages
            for (let i = 0; i < targetMessages; i++) {
              await publish(topic, { data: Buffer.from(`leak test ${i}`) })
            }

            // Wait for all messages
            await new Promise((resolve) => {
              const checkInterval = setInterval(() => {
                if (messagesReceived >= targetMessages) {
                  clearInterval(checkInterval)
                  resolve()
                }
              }, 100)
            })

            subscription.close()

            // Force GC
            global.gc()
            await new Promise(resolve => setTimeout(resolve, 100))
            global.gc()

            const afterMemory = process.memoryUsage().heapUsed
            const memoryIncrease = afterMemory - initialMemory

            // Memory should not increase significantly (less than 10MB for 50 messages)
            // If WeakMap is leaking, this would be much higher
            assert.ok(
              memoryIncrease < 10 * 1024 * 1024,
              `Memory increase should be minimal but was ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB`
            )
          })
        })
      })

      function expectSpanWithDefaults (expected) {
        let prefixedResource
        const method = expected.meta?.['pubsub.method']
        const spanKind = expected.meta?.['span.kind']

        if (method === 'publish') {
          prefixedResource = `${method} to Topic ${topicName}`
        } else if (spanKind === 'consumer') {
          prefixedResource = `Message from ${topicName}`
        } else if (method) {
          prefixedResource = `${method} ${resource}`
        } else {
          prefixedResource = resource
        }

        let defaultOpName = 'pubsub.receive'
        if (spanKind === 'consumer') {
          defaultOpName = expectedSchema.receive.opName
        } else if (spanKind === 'producer') {
          defaultOpName = expectedSchema.send.opName
        } else {
          defaultOpName = expectedSchema.controlPlane.opName
        }

        const service = method ? 'test-pubsub' : 'test'
        expected = withDefaults({
          name: defaultOpName,
          resource: prefixedResource,
          service,
          error: 0,
          meta: {
            component: 'google-cloud-pubsub',
            'gcloud.project_id': project
          }
        }, expected)

        return expectSomeSpan(agent, expected, TIMEOUT)
      }
    })
  })
})

function getProjectId () {
  return `test-project-${id()}`
}

function getTopic () {
  return `test-topic-${id()}`
}

function publish (topic, options) {
  if (topic.publishMessage) {
    return topic.publishMessage(options)
  } else {
    return topic.publish(options.data)
  }
}
