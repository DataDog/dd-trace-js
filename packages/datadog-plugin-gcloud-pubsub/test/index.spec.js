'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const plugin = require('../src')

const BASE_PROJECT_ID = `test-project-${bigRandom()}-`
let projectCounter = 0
const BASE_TOPIC = `test-topic-${bigRandom()}-`
let topicCounter = 0

wrapIt()

describe('Plugin', () => {
  let tracer
  let gpubsub

  describe('gcloud-pubsub', () => {
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
      describe('without configuration', () => {
        beforeEach(() => {
          tracer = require('../../dd-trace')
          agent.load(plugin, '@google-cloud/pubsub')
          gpubsub = require(`../../../versions/@google-cloud/pubsub@${version}`).get()
        })

        describe('createTopic', () => {
          it('should be instrumented', () =>
            performTest({
              meta: { 'pubsub.method': 'createTopic' }
            }, async ({ pubsub, topicName }) => {
              await pubsub.createTopic(topicName)
            })
          )
        })

        describe('publishMessage', () => {
          it('should be instrumented', () =>
            performTest({
              meta: { 'pubsub.method': 'createTopic' }
            }, async ({ pubsub, topicName }) => {
              const [topic] = await pubsub.createTopic(topicName)
              return topic.publishMessage({ data: Buffer.from('hello') })
            })
          )
        })

        describe('onMessage', () => {
          it('should be instrumented', () =>
            performTest({
              name: 'gpubsub.onmessage'
            }, async ({ pubsub, topicName }) => {
              const [topic] = await pubsub.createTopic(topicName)
              const [sub] = await topic.createSubscription('foo')
              sub.on('message', () => {})
              return topic.publishMessage({ data: Buffer.from('hello') })
            })
          )

          it('should give the current span a parentId from the sender', () =>
            performTest({
              name: 'gpubsub.onmessage'
            }, async ({ pubsub, topicName }) => {
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
              await topic.publishMessage({ data: Buffer.from('hello') })
              return rxPromise
            })
          )
        })
      })

      describe('with configuration', () => {
        beforeEach(() => {
          tracer = require('../../dd-trace')
          agent.load(plugin, '@google-cloud/pubsub', {
            service: 'a_test_service'
          })
          gpubsub = require(`../../../versions/@google-cloud/pubsub@${version}`).get()
        })

        describe('createTopic', () => {
          it('should be instrumented', () =>
            performTest({
              service: 'a_test_service',
              meta: { 'pubsub.method': 'createTopic' }
            }, async ({ pubsub, topicName }) => {
              await pubsub.createTopic(topicName)
            })
          )
        })
      })
    })
  })

  function performTest (expected, test) {
    const project = getProjectId()
    const topicName = getTopic()
    const resource = `projects/${project}/topics/${topicName}`

    expected = withDefaults({
      name: 'gpubsub.request',
      resource,
      service: 'test-pubsub',
      error: 0,
      meta: {
        component: 'google-cloud-pubsub',
        'pubsub.topic': resource,
        'pubsub.projectid': project
      }
    }, expected)

    const expectationPromise = expectSomeSpan(agent, expected)

    const { PubSub } = gpubsub
    const pubsub = new PubSub({ projectId: project })
    const testPromise = test({ project, topicName, pubsub })
    return Promise.all([expectationPromise, testPromise])
  }
})

function getProjectId () {
  return BASE_PROJECT_ID + projectCounter++
}

function getTopic () {
  return BASE_TOPIC + topicCounter++
}

function bigRandom () {
  return Math.floor(Math.pow(Math.random(), Math.random()) * Number.MAX_SAFE_INTEGER)
}
