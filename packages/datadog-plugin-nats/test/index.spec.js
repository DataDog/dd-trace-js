'use strict'

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

/**
 * Find a span matching the expected object within any trace in the payload.
 * @param {Array<Array<object>>} traces
 * @param {object} expected
 */
function assertSomeSpan (traces, expected) {
  for (const trace of traces) {
    for (const span of trace) {
      try {
        assertObjectContains(span, expected)
        return
      } catch {
        // try next span
      }
    }
  }
  throw new Error(`No span found matching: ${JSON.stringify(expected)}`)
}

createIntegrationTestSuite('nats', 'nats', {
  category: 'messaging',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('publish() - send', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'nats.send',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'nats',
            'messaging.destination.name': 'test.publish',
            'messaging.operation': 'send',
            component: 'nats',
          },
          metrics: {},
        }
      )

      await testSetup.publish()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'nats.send',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'nats',
            'messaging.operation': 'send',
            component: 'nats',
          },
          metrics: {},
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

  describe('processMsg() - receive', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const expected = {
        name: 'nats.process',
        meta: {
          'span.kind': 'consumer',
          'messaging.system': 'nats',
          'messaging.destination.name': 'test.consume',
          'messaging.operation': 'receive',
          component: 'nats',
        },
        metrics: {},
      }

      const traceAssertion = agent.assertSomeTraces(traces => {
        assertSomeSpan(traces, expected)
      })

      await testSetup.processMsg()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const expected = {
        name: 'nats.process',
        meta: {
          'span.kind': 'consumer',
          'messaging.system': 'nats',
          'messaging.operation': 'receive',
          component: 'nats',
        },
        metrics: {},
        error: 1,
      }

      const traceAssertion = agent.assertSomeTraces(traces => {
        assertSomeSpan(traces, expected)
      }, { timeoutMs: 4000 })

      try {
        await testSetup.processMsgError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('request() - send', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'nats.send',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'nats',
            'messaging.destination.name': 'test.request',
            'messaging.operation': 'send',
            component: 'nats',
          },
          metrics: {},
        }
      )

      await testSetup.request()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'nats.send',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'nats',
            'messaging.operation': 'send',
            component: 'nats',
          },
          metrics: {},
          error: 1,
        }
      )

      try {
        await testSetup.requestError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
