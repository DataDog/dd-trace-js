'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const id = require('../../dd-trace/src/id')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

// The roundtrip to the pubsub emulator takes time. Sometimes a *long* time.
const TIMEOUT = 30000

describe('Plugin', () => {
  let tracer

  describe('google-cloud-pubsub', function () {
    this.timeout(TIMEOUT)

    before(() => {
      process.env.PUBSUB_EMULATOR_HOST = 'localhost:8081'
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

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load('google-cloud-pubsub')
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
              meta: {
                'pubsub.method': 'createTopic',
                'span.kind': 'client',
                'component': 'google-cloud-pubsub'
              }
            })
            await pubsub.createTopic(topicName)
            return expectedSpanPromise
          })

          it('should be instrumented w/ error', async () => {
            const error = new Error('bad')
            const expectedSpanPromise = expectSpanWithDefaults({
              error: 1,
              meta: {
                'pubsub.method': 'createTopic',
                [ERROR_MESSAGE]: error.message,
                [ERROR_TYPE]: error.name,
                [ERROR_STACK]: error.stack,
                'component': 'google-cloud-pubsub'
              }
            })
            pubsub.getClient_ = function (config, callback) {
              callback(error)
            }
            try {
              await pubsub.createTopic(topicName)
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
              meta: {
                'pubsub.topic': resource,
                'pubsub.method': 'publish',
                'span.kind': 'producer',
                'component': 'google-cloud-pubsub'
              }
            })
            const [topic] = await pubsub.createTopic(topicName)
            await publish(topic, { data: Buffer.from('hello') })
            return expectedSpanPromise
          })

          it('should be instrumented w/ error', async () => {
            const error = new Error('bad')
            const expectedSpanPromise = expectSpanWithDefaults({
              error: 1,
              meta: {
                'pubsub.method': 'publish',
                [ERROR_MESSAGE]: error.message,
                [ERROR_TYPE]: error.name,
                [ERROR_STACK]: error.stack,
                'component': 'google-cloud-pubsub'
              }
            })
            const [topic] = await pubsub.createTopic(topicName)
            pubsub.getClient_ = function (config, callback) {
              callback(error)
            }
            try {
              await publish(topic, { data: Buffer.from('hello') })
            } catch (e) {
              // this is just to prevent mocha from crashing
            }
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
        })

        describe('onmessage', () => {
          it('should be instrumented', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: 'pubsub.receive',
              type: 'worker',
              meta: {
                'component': 'google-cloud-pubsub',
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
              name: 'pubsub.receive',
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
              name: 'pubsub.receive',
              error: 1,
              meta: {
                [ERROR_MESSAGE]: error.message,
                [ERROR_TYPE]: error.name,
                [ERROR_STACK]: error.stack,
                'component': 'google-cloud-pubsub'
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
        })
      })

      describe('with configuration', () => {
        beforeEach(() => {
          return agent.load('google-cloud-pubsub', {
            service: 'a_test_service'
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
              service: 'a_test_service',
              meta: { 'pubsub.method': 'createTopic' }
            })
            await pubsub.createTopic(topicName)
            return expectedSpanPromise
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
            'component': 'google-cloud-pubsub',
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
