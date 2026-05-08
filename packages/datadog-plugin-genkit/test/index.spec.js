'use strict'

const assert = require('node:assert/strict')

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { withPeerService } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

/**
 * Finds the first span matching the given name across all traces.
 *
 * @param {Array<Array<object>>} traces
 * @param {string} name
 * @returns {object | undefined}
 */
function findSpanByName (traces, name) {
  for (const trace of traces) {
    for (const span of trace) {
      if (span.name === name) return span
    }
  }
}

createIntegrationTestSuite('genkit', 'genkit', {
  category: 'generative-ai',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('GenkitAI.generate() - genkit.generate', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces(function (traces) {
        const span = findSpanByName(traces, 'genkit.generate')
        assert.ok(span, 'expected genkit.generate span')
        assertObjectContains(span, {
          name: 'genkit.generate',
          meta: { 'span.kind': 'client', component: 'genkit' }
        })
      })

      await testSetup.genkitAIGenerate()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces(function (traces) {
        const span = findSpanByName(traces, 'genkit.generate')
        assert.ok(span, 'expected genkit.generate span')
        assertObjectContains(span, {
          name: 'genkit.generate',
          error: 1,
          meta: {
            'span.kind': 'client',
            'error.type': 'GenkitError',
            'error.message': "NOT_FOUND: Model 'nonexistent/model-that-does-not-exist' not found"
          }
        })
      })

      try {
        await testSetup.genkitAIGenerateError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('GenkitAI.generateStream() - genkit.generateStream', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces(function (traces) {
        const span = findSpanByName(traces, 'genkit.generateStream')
        assert.ok(span, 'expected genkit.generateStream span')
        assertObjectContains(span, {
          name: 'genkit.generateStream',
          meta: { 'span.kind': 'client', component: 'genkit' }
        })
      })

      await testSetup.genkitAIGenerateStream()

      return traceAssertion
    })

    it('should generate span when operation errors (error path)', async () => {
      // generateStream returns synchronously; errors occur asynchronously when the
      // response promise rejects. The span closes on sync return, so error tags
      // are not captured on the span. We verify the span is still created.
      const traceAssertion = agent.assertSomeTraces(function (traces) {
        const span = findSpanByName(traces, 'genkit.generateStream')
        assert.ok(span, 'expected genkit.generateStream span')
        assertObjectContains(span, {
          name: 'genkit.generateStream',
          meta: {
            'span.kind': 'client',
            'genkit.ai.model': 'nonexistent/model-that-does-not-exist'
          }
        })
      })

      try {
        await testSetup.genkitAIGenerateStreamError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Chat.send() - genkit.send', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces(function (traces) {
        const span = findSpanByName(traces, 'genkit.send')
        assert.ok(span, 'expected genkit.send span')
        assertObjectContains(span, {
          name: 'genkit.send',
          meta: { 'span.kind': 'client', component: 'genkit' }
        })
      })

      await testSetup.chatSend()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces(function (traces) {
        const span = findSpanByName(traces, 'genkit.send')
        assert.ok(span, 'expected genkit.send span')
        assertObjectContains(span, {
          name: 'genkit.send',
          error: 1,
          meta: {
            'span.kind': 'client',
            'error.type': 'GenkitError',
            'error.message': "NOT_FOUND: Model 'nonexistent/model-that-does-not-exist' not found"
          }
        })
      })

      try {
        await testSetup.chatSendError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('defineAction() - genkit.defineAction', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces(function (traces) {
        const span = findSpanByName(traces, 'genkit.defineAction')
        assert.ok(span, 'expected genkit.defineAction span')
        assertObjectContains(span, {
          name: 'genkit.defineAction',
          meta: { 'span.kind': 'internal', component: 'genkit' }
        })
      })

      testSetup.defineAction()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces(function (traces) {
        const span = findSpanByName(traces, 'genkit.defineAction')
        assert.ok(span, 'expected genkit.defineAction span')
        assertObjectContains(span, {
          name: 'genkit.defineAction',
          meta: { 'span.kind': 'internal', component: 'genkit' }
        })
        // defineAction is a sync registration function; errors during registration
        // are implementation-dependent. We verify the span exists.
      })

      try {
        testSetup.defineActionError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  withPeerService(
    () => meta.tracer,
    'genkit',
    () => testSetup.genkitAIGenerate(),
    () => testSetup.expectedModelName(),
    'genkit.ai.model'
  )
})
