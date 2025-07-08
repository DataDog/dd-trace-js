'use strict'

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
      process.env.DD_DATA_STREAMS_ENABLED = true
    })

    after(() => {
      delete process.env.PUBSUB_EMULATOR_HOST
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
        beforeEach(() => {
          return agent.load('google-cloud-pubsub', { dsmEnabled: false })
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
              const [topic] = await pubsub.createTopic(topicName)
              const [sub] = await topic.createSubscription('foo')
              sub.on('message', msg => msg.ack())
              await publish(topic, { data: Buffer.from('hello') })
            },
            rawExpectedSchema.receive
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
              expect(statsPointsReceived).to.be.at.least(1)
              expect(agent.dsmStatsExist(agent, expectedProducerHash.readBigUInt64BE(0).toString())).to.equal(true)
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
            expect(recordCheckpointSpy.args[0][0].hasOwnProperty('payloadSize'))
          })

          it('when consuming a message', async () => {
            await publish(dsmTopic, { data: Buffer.from('DSM consume payload size') })

            await consume(async () => {
              expect(recordCheckpointSpy.args[0][0].hasOwnProperty('payloadSize'))
            })
          })
        })
      })

      function expectSpanWithDefaults (expected) {
        const prefixedResource = [expected.meta['pubsub.method'], resource].filter(x => x).join(' ')
        const service = expected.meta['pubsub.method'] ? 'test-pubsub' : 'test'
        expected = withDefaults({
          name: 'pubsub.request',
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
