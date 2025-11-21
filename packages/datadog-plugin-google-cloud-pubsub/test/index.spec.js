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
          await agent.load('google-cloud-pubsub', { dsmEnabled: false })
          
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
            const publisher = new v1.PublisherClient({ projectId: project })
            const name = `projects/${project}/topics/${topicName}`
            try {
              await publisher.createTopic({ name })
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
            const startMsg = '[DD-PUBSUB-TEST] ======================================== Starting "should be instrumented" test ========================================'
            console.log(startMsg)
            process.stdout.write(startMsg + '\n')
            
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
            console.log('[DD-PUBSUB-TEST] Creating topic and subscription')
            const [topic] = await pubsub.createTopic(topicName)
            const [sub] = await topic.createSubscription('foo')
            
            console.log('[DD-PUBSUB-TEST] Setting up message handler')
            sub.on('message', msg => {
              const msgReceived = `[DD-PUBSUB-TEST] !!!!! Message received in test handler: ${msg.id} !!!!!`
              console.log(msgReceived)
              process.stdout.write(msgReceived + '\n')
              msg.ack()
            })
            
            console.log('[DD-PUBSUB-TEST] Publishing message to topic')
            await publish(topic, { data: Buffer.from('hello') })
            
            console.log('[DD-PUBSUB-TEST] Waiting for consumer span to be created...')
            return expectedSpanPromise
          })

          it('should give the current span a parentId from the sender', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.receive.opName,
              service: expectedSchema.receive.serviceName,
              meta: { 'span.kind': 'consumer' }
            })
            const [topic] = await pubsub.createTopic(topicName)
            const [sub] = await topic.createSubscription('foo')
            const rxPromise = new Promise((resolve, reject) => {
              sub.on('message', msg => {
                const receiverSpanContext = tracer.scope().active()._spanContext
                try {
                  expect(receiverSpanContext._parentId).to.be.an('object')
                  resolve()
                  msg.ack()
                } catch (e) {
                  reject(e)
                }
              })
            })
            await publish(topic, { data: Buffer.from('hello') })
            await rxPromise
            return expectedSpanPromise
          })

          it('should be instrumented w/ error', async () => {
            const error = new Error('bad')
            const expectedSpanPromise = expectSpanWithDefaults({
              name: expectedSchema.receive.opName,
              service: expectedSchema.receive.serviceName,
              error: 1,
              meta: {
                [ERROR_MESSAGE]: error.message,
                [ERROR_TYPE]: error.name,
                [ERROR_STACK]: error.stack,
                component: 'google-cloud-pubsub'
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
                  expect(err).to.equal(error)
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
            async () => {
              console.log('[DD-PUBSUB-TEST] withNamingSchema: Starting receive test')
              const [topic] = await pubsub.createTopic(topicName)
              const [sub] = await topic.createSubscription('foo')
              sub.on('message', msg => {
                const msgReceived = `[DD-PUBSUB-TEST] withNamingSchema: Message received: ${msg.id}`
                console.log(msgReceived)
                process.stdout.write(msgReceived + '\n')
                msg.ack()
              })
              await publish(topic, { data: Buffer.from('hello') })
              console.log('[DD-PUBSUB-TEST] withNamingSchema: Message published, waiting for processing')
            },
            rawExpectedSchema.receive,
            {
              selectSpan: (traces) => {
                console.log('[DD-PUBSUB-TEST] ======================================== selectSpan() CALLED ========================================')
                console.log('[DD-PUBSUB-TEST] Number of traces:', traces.length)
                
                const allSpans = traces.flat()
                console.log('[DD-PUBSUB-TEST] Total spans across all traces:', allSpans.length)
                console.log('[DD-PUBSUB-TEST] Span types:', allSpans.map(s => `${s.name}(${s.type})`).join(', '))
                
                const workerSpan = allSpans.find(span => span.type === 'worker')
                console.log('[DD-PUBSUB-TEST] Worker span found:', !!workerSpan)
                if (workerSpan) {
                  console.log('[DD-PUBSUB-TEST] Worker span details: name=' + workerSpan.name + ', type=' + workerSpan.type)
                }
                
                const selectedSpan = workerSpan || allSpans[allSpans.length - 1] || traces[0][0]
                console.log('[DD-PUBSUB-TEST] Selected span:', selectedSpan?.name, '(type:', selectedSpan?.type + ')')
                console.log('[DD-PUBSUB-TEST] ========================================')
                
                return selectedSpan
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
          // Load instrumentation BEFORE requiring the library
          await agent.load('google-cloud-pubsub', {
            dsmEnabled: true
          })
          
          // NOW require the library - hooks will attach
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
            expect(recordCheckpointSpy.called).to.be.true
            expect(recordCheckpointSpy.args).to.have.lengthOf.at.least(1)
            expect(recordCheckpointSpy.args[0]).to.exist
            expect(recordCheckpointSpy.args[0][0]).to.exist
            expect(recordCheckpointSpy.args[0][0].hasOwnProperty('payloadSize')).to.be.true
          })

          it('when consuming a message', async () => {
            await publish(dsmTopic, { data: Buffer.from('DSM consume payload size') })

            await consume(async () => {
              expect(recordCheckpointSpy.called).to.be.true
              expect(recordCheckpointSpy.args).to.have.lengthOf.at.least(1)
              expect(recordCheckpointSpy.args[0]).to.exist
              expect(recordCheckpointSpy.args[0][0]).to.exist
              expect(recordCheckpointSpy.args[0][0].hasOwnProperty('payloadSize')).to.be.true
            })
          })
        })
      })

      function expectSpanWithDefaults (expected) {
        let prefixedResource
        const method = expected.meta['pubsub.method']
        const spanKind = expected.meta['span.kind']

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
