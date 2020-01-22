'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const plugin = require('../src')
const id = require('../../dd-trace/src/id')

const BASE_PROJECT_ID = `test-project-${id()}-`
let projectCounter = 0
const BASE_TOPIC = `test-topic-${id()}-`
let topicCounter = 0

wrapIt()

describe('Plugin', () => {
  let tracer

  describe('google-cloud-pubsub', function () {
    this.timeout(5000) // The roundtrip to the pubsub emulator takes time

    before(() => {
      process.env.PUBSUB_EMULATOR_HOST = 'localhost:8042'
    })
    after(() => {
      delete process.env.PUBSUB_EMULATOR_HOST
    })
    afterEach(() => {
      agent.close()
      agent.wipe()
    })
    withVersions(plugin, '@google-cloud/pubsub', version => {
      let pubsub
      let project
      let topicName
      let resource

      describe('without configuration', () => {
        beforeEach(() => {
          tracer = require('../../dd-trace')
          agent.load(plugin, 'google-cloud-pubsub')
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
                'span.kind': 'producer'
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
                'error.msg': error.message,
                'error.type': error.name,
                'error.stack': error.stack
              }
            })
            pubsub.getClient_ = function () {
              throw error
            }
            try {
              await pubsub.createTopic(topicName)
            } catch (e) {
              // this is just to prevent mocha from crashing
            }
            return expectedSpanPromise
          })
        })

        describe('publish', () => {
          it('should be instrumented', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              meta: {
                'pubsub.method': 'publish',
                'span.kind': 'producer'
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
                'error.msg': error.message,
                'error.type': error.name,
                'error.stack': error.stack
              }
            })
            const [topic] = await pubsub.createTopic(topicName)
            pubsub.getClient_ = function () {
              throw error
            }
            const request = topic.request
            topic.request = function () {
              try {
                request.apply(this, arguments)
              } catch (e) {
                // this is just to prevent mocha from crashing
              }
            }
            publish(topic, { data: Buffer.from('hello') })
            return expectedSpanPromise
          })
        })

        describe('onmessage', () => {
          it('should be instrumented', async () => {
            const expectedSpanPromise = expectSpanWithDefaults({
              name: 'pubsub.receive',
              meta: { 'span.kind': 'consumer' }
            })
            const [topic] = await pubsub.createTopic(topicName)
            const [sub] = await topic.createSubscription('foo')
            sub.on('message', () => {})
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
              sub.on('message', () => {
                const receiverSpanContext = tracer.scope().active()._spanContext
                try {
                  expect(receiverSpanContext._parentId).to.be.an('object')
                  resolve()
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
                'error.msg': error.message,
                'error.type': error.name,
                'error.stack': error.stack
              }
            })
            const [topic] = await pubsub.createTopic(topicName)
            const [sub] = await topic.createSubscription('foo')
            const emit = sub.emit
            sub.emit = function emitWrapped () {
              try {
                return emit.apply(this, arguments)
              } catch (e) {
                // this is just to prevent mocha from crashing
              }
            }
            sub.on('message', () => {
              throw error
            })
            await publish(topic, { data: Buffer.from('hello') })
            return expectedSpanPromise
          })
        })
      })

      describe('with configuration', () => {
        beforeEach(() => {
          tracer = require('../../dd-trace')
          agent.load(plugin, 'google-cloud-pubsub', {
            service: 'a_test_service'
          })
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
        const prefixedResource = `${expected.meta['pubsub.method'] || 'receive'}:${resource}`
        expected = withDefaults({
          name: 'pubsub.request',
          resource: prefixedResource,
          service: 'test-pubsub',
          error: 0,
          meta: {
            component: '@google-cloud/pubsub',
            'pubsub.topic': resource,
            'pubsub.project_id': project
          }
        }, expected)
        return expectSomeSpan(agent, expected)
      }
    })
  })
})

function getProjectId () {
  return BASE_PROJECT_ID + projectCounter++
}

function getTopic () {
  return BASE_TOPIC + topicCounter++
}

function publish (topic, options) {
  if (topic.publishMessage) {
    return topic.publishMessage(options)
  } else {
    return topic.publish(options.data)
  }
}
