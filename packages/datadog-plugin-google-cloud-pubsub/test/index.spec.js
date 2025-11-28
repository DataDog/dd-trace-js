'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const sinon = require('sinon')

const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const id = require('../../dd-trace/src/id')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const { expectedSchema, rawExpectedSchema } = require('./naming')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH, DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')

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
    })

    after(() => {
      delete process.env.PUBSUB_EMULATOR_HOST
      delete process.env.DD_DATA_STREAMS_ENABLED
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
      let expectedProducerHash
      let expectedConsumerHash

      describe('without configuration', () => {
        beforeEach(async () => {
          const msg = `[DD-PUBSUB-TEST] ======================================== Loading google-cloud-pubsub plugin at ${new Date().toISOString()} ========================================`
          console.log(msg)
          process.stdout.write(msg + '\n')
          
          // CRITICAL: Load instrumentation BEFORE requiring @google-cloud/pubsub
          // This ensures addHook() wrappers attach before the module is cached
          // flushMinSpans: 1 forces the processor to export partial traces (critical for tests!)
          await agent.load('google-cloud-pubsub', { dsmEnabled: false }, { flushInterval: 0, flushMinSpans: 1 })
          
          const initMsg = `[DD-PUBSUB-TEST] Initializing test environment for version: ${version}`
          console.log(initMsg)
          process.stdout.write(initMsg + '\n')
          
          // NOW require the library - hooks will attach
          tracer = require('../../dd-trace')
          gax = require('../../../versions/google-gax@3.5.7').get()
          const lib = require(`../../../versions/@google-cloud/pubsub@${version}`).get()
          project = getProjectId()
          topicName = getTopic()
          resource = `projects/${project}/topics/${topicName}`
          v1 = lib.v1
          pubsub = new lib.PubSub({ projectId: project })
          
          const readyMsg = `[DD-PUBSUB-TEST] Test environment ready - project: ${project}, topic: ${topicName}`
          console.log(readyMsg)
          process.stdout.write(readyMsg + '\n')
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
                expect(tracer.scope().active()).to.equal(firstSpan)
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
                expect(tracer.scope().active()).to.equal(firstSpan)
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
            const [topic] = await pubsub.createTopic(topicName)
            const [sub] = await topic.createSubscription('foo')

            // Set up listener - wait for ack AND remove/finish to complete
            const messagePromise = new Promise((resolve) => {
              sub.on('message', msg => {
                msg.ack()
                // Wait 1000ms to ensure both producer and consumer spans reach test agent
                setTimeout(resolve, 1000)
              })
            })

            await publish(topic, { data: Buffer.from('hello') })
            await messagePromise

            // NOW expect the span AFTER message processing completes
            return expectSpanWithDefaults({
              name: expectedSchema.receive.opName,
              service: expectedSchema.receive.serviceName,
              type: 'worker',
              meta: {
                component: 'google-cloud-pubsub',
                'span.kind': 'consumer'
              },
              metrics: {
                'pubsub.ack': 1
              }
            })
          })

          it('should give the current span a parentId from the sender', async () => {
            const [topic] = await pubsub.createTopic(topicName)
            const [sub] = await topic.createSubscription('foo')
            
            const messagePromise = new Promise((resolve) => {
            sub.on('message', msg => {
                const activeSpan = tracer.scope().active()
                if (activeSpan) {
                  const receiverSpanContext = activeSpan._spanContext
                  expect(receiverSpanContext._parentId).to.be.an('object')
                }
              msg.ack()
                // Wait 1000ms for remove() -> bindFinish() -> flush to complete
                setTimeout(resolve, 1000)
              })
            })
            
            await publish(topic, { data: Buffer.from('hello') })
            await messagePromise

            // NOW expect the span AFTER message processing completes
            return expectSpanWithDefaults({
              name: expectedSchema.receive.opName,
              service: expectedSchema.receive.serviceName,
              type: 'worker',
              meta: {
                component: 'google-cloud-pubsub',
                'span.kind': 'consumer'
              }
            })
          })

          it('should be instrumented w/ error', async () => {
            const error = new Error('bad')
            const [topic] = await pubsub.createTopic(topicName)
            const [sub] = await topic.createSubscription('foo')

            const messagePromise = new Promise((resolve) => {
              sub.on('message', msg => {
                try {
                  throw error
                } catch (err) {
                  // Error is caught and traced, but we don't rethrow
                } finally {
                  msg.ack()
                  // Wait 1000ms for remove() -> bindFinish() -> flush to complete
                  setTimeout(resolve, 1000)
                }
              })
            })

            await publish(topic, { data: Buffer.from('hello') })
            await messagePromise

            // NOW expect the span AFTER message processing completes
            return expectSpanWithDefaults({
              name: expectedSchema.receive.opName,
              service: expectedSchema.receive.serviceName,
              type: 'worker',
              error: 1,
              meta: {
                [ERROR_MESSAGE]: error.message,
                [ERROR_TYPE]: error.name,
                [ERROR_STACK]: error.stack,
                component: 'google-cloud-pubsub',
                'span.kind': 'consumer'
                }
            })
          })

          withNamingSchema(
            async (config) => {
              const [topic] = await pubsub.createTopic(topicName)
              const [sub] = await topic.createSubscription('foo')

              // Set up message handler
              const messagePromise = new Promise((resolve) => {
              sub.on('message', msg => {
                msg.ack()
                  // Wait 1000ms for remove() -> bindFinish() -> flush to complete
                  setTimeout(resolve, 1000)
                })
              })

              // Publish message with trace context
              await publish(topic, { data: Buffer.from('hello') })
              
              // Wait for message processing and flush
              await messagePromise
            },
            rawExpectedSchema.receive,
            {
              // Custom selectSpan: look through all traces for a consumer span
              // (withNamingSchema will check the name matches expected opName)
              selectSpan: (traces) => {
                // Flatten all spans from all traces
                for (const trace of traces) {
                  for (const span of trace) {
                    // Return the first worker-type span (consumer span)
                    if (span.type === 'worker') {
                      return span
                    }
                  }
                }
                // If no worker span found, return undefined to trigger retry
                // (withNamingSchema's assertSomeTraces will keep waiting)
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
        beforeEach(async () => {
          // Load instrumentation BEFORE requiring the library
          await agent.load('google-cloud-pubsub', {
            service: 'a_test_service',
            dsmEnabled: false
          })
          
          // NOW require the library - hooks will attach
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

        before(async () => {
          // Load instrumentation BEFORE requiring the library with DSM ENABLED
          await agent.load('google-cloud-pubsub', {
            dsmEnabled: true
          }, {
            // Also enable DSM on the tracer itself
            dsmEnabled: true,
            flushInterval: 0
          })
          
          // NOW require the library - hooks will attach
          tracer = require('../../dd-trace')
          
          // CRITICAL: Manually enable DSM on the existing tracer processor
          // The tracer was initialized in a previous suite with DSM disabled
          if (!tracer._dataStreamsProcessor) {
            // If processor doesn't exist, create it
            const DataStreamsProcessor = require('../../dd-trace/src/datastreams/processor').DataStreamsProcessor
            const DataStreamsManager = require('../../dd-trace/src/datastreams/manager').DataStreamsManager
            const DataStreamsCheckpointer = require('../../dd-trace/src/datastreams/checkpointer').DataStreamsCheckpointer
            tracer._dataStreamsProcessor = new DataStreamsProcessor({
              dsmEnabled: true,
              hostname: '127.0.0.1',
              port: tracer._tracer?._port || 8126,
              url: tracer._tracer?._url,
              env: 'tester',
              service: 'test',
              flushInterval: 5000
            })
            tracer._dataStreamsManager = new DataStreamsManager(tracer._dataStreamsProcessor)
            tracer.dataStreamsCheckpointer = new DataStreamsCheckpointer(tracer)
          } else {
            // If it exists but is disabled, enable it
            tracer._dataStreamsProcessor.enabled = true
            if (!tracer._dataStreamsProcessor.timer) {
              tracer._dataStreamsProcessor.timer = setInterval(
                tracer._dataStreamsProcessor.onInterval.bind(tracer._dataStreamsProcessor),
                tracer._dataStreamsProcessor.flushInterval || 5000
              )
              tracer._dataStreamsProcessor.timer.unref()
            }
          }
          
          // Force enable DSM on the plugin
          tracer.use('google-cloud-pubsub', { dsmEnabled: true })
          
          const { PubSub } = require(`../../../versions/@google-cloud/pubsub@${version}`).get()
          project = getProjectId()
          resource = `projects/${project}/topics/${dsmTopicName}`
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

        describe('should set a DSM checkpoint', () => {
          it('on produce', async () => {
            console.log('[TEST DSM] Testing produce checkpoint')
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
              expect(statsPointsReceived).to.be.at.least(1)
              expect(agent.dsmStatsExist(agent, expectedProducerHash.readBigUInt64BE(0).toString())).to.equal(true)
            }, { timeoutMs: TIMEOUT })
          })

          it('on consume', async () => {
            console.log('[TEST DSM] Testing consume checkpoint')
            await publish(dsmTopic, { data: Buffer.from('DSM consume checkpoint') })
            console.log('[TEST DSM] Message published, setting up consumer')
            await consume(async () => {
              console.log('[TEST DSM] Message consumed')
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
                expect(statsPointsReceived).to.be.at.least(2)
                expect(agent.dsmStatsExist(agent, expectedConsumerHash.readBigUInt64BE(0).toString())).to.equal(true)
              }, { timeoutMs: TIMEOUT })
            })
          })
        })
      })

      function expectSpanWithDefaults (expected) {
        let prefixedResource
        const method = expected.meta?.['pubsub.method']
        const spanKind = expected.meta?.['span.kind']

        if (method === 'publish') {
          // For publish operations, use the new format: "publish to Topic <topic-name>"
          prefixedResource = `${method} to Topic ${topicName}`
        } else if (spanKind === 'consumer') {
          // For consumer operations, use the new format: "Message from <topic-name>"
          prefixedResource = `Message from ${topicName}`
        } else if (method) {
          // For other operations, use the old format: "<method> <full-resource-path>"
          prefixedResource = `${method} ${resource}`
        } else {
          prefixedResource = resource
        }

        // Determine the default operation name based on span kind
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
        
        return expectSomeSpan(agent, expected, { timeoutMs: TIMEOUT })
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
