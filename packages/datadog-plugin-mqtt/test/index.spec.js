'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { ANY_STRING } = require('../../../integration-tests/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('mqtt', 'mqtt', {
  category: 'messaging',
}, (meta) => {
  const { agent } = meta

  before(async function () {
    this.timeout(30000)
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('publish() - send', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'mqtt.send',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'mqtt',
            'messaging.destination.name': 'dd-trace-test-topic',
            'messaging.operation': 'send',
            component: 'mqtt',
          },
        }
      )

      await testSetup.publish()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'mqtt.send',
          meta: {
            'span.kind': 'producer',
            'error.type': ANY_STRING,
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
            'messaging.system': 'mqtt',
            'messaging.destination.name': 'dd-trace-test-topic',
            'messaging.operation': 'send',
            component: 'mqtt',
          },
          error: 1,
        }
      )

      try {
        await testSetup.publishError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('publishAsync() - send', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'mqtt.send',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'mqtt',
            'messaging.destination.name': 'dd-trace-test-topic',
            'messaging.operation': 'publish',
            component: 'mqtt',
          },
        }
      )

      await testSetup.publishAsync()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'mqtt.send',
          meta: {
            'span.kind': 'producer',
            'error.type': ANY_STRING,
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
            'messaging.system': 'mqtt',
            'messaging.destination.name': 'dd-trace-test-topic',
            'messaging.operation': 'publish',
            component: 'mqtt',
          },
          error: 1,
        }
      )

      try {
        await testSetup.publishAsyncError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('handlePublish() - receive', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'mqtt.process',
          meta: {
            'span.kind': 'consumer',
            'messaging.system': 'mqtt',
            'messaging.destination.name': 'dd-trace-test-topic',
            'messaging.operation': 'receive',
            component: 'mqtt',
          },
        }
      )

      await testSetup.handlePublish()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'mqtt.process',
          meta: {
            'span.kind': 'consumer',
            'error.type': ANY_STRING,
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
            'messaging.system': 'mqtt',
            'messaging.destination.name': 'dd-trace-test-topic',
            'messaging.operation': 'receive',
            component: 'mqtt',
          },
          error: 1,
        },
        { timeoutMs: 10000 }
      )

      await testSetup.handlePublishError()

      return traceAssertion
    })
  })

  describe('handlePubrel() - receive', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'mqtt.process',
          meta: {
            'span.kind': 'consumer',
            'messaging.system': 'mqtt',
            'messaging.operation': 'receive',
            component: 'mqtt',
          },
        }
      )

      await testSetup.handlePubrel()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'mqtt.process',
          meta: {
            'span.kind': 'consumer',
            'error.type': ANY_STRING,
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
            'messaging.system': 'mqtt',
            'messaging.operation': 'receive',
            component: 'mqtt',
          },
          error: 1,
        },
        { timeoutMs: 10000 }
      )

      await testSetup.handlePubrelError()

      return traceAssertion
    })
  })
})
