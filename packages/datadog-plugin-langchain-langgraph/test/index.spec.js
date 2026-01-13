'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('langchain-langgraph', '@langchain/langgraph', {
  category: 'llm'
}, (meta) => {
  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('Pregel.invoke() - invoke', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = meta.agent.assertFirstTraceSpan(
        {
          name: 'langchain-langgraph.invoke',
          meta: {
            'span.kind': 'client',
            'component': 'langchain-langgraph'
          },
          metrics: {}
        }
      )

      const result = await testSetup.pregelInvoke()

      // Verify library behavior: workflow should have executed and updated state
      if (!result || typeof result !== 'object') {
        throw new Error('Expected invoke to return a result object')
      }
      if (result.count !== 2) {
        throw new Error(`Expected count to be 2 after 2 iterations, got ${result.count}`)
      }
      if (!result.messages || result.messages.length < 3) {
        throw new Error(`Expected at least 3 messages (original + 2 responses), got ${result.messages?.length}`)
      }

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = meta.agent.assertFirstTraceSpan(
        {
          name: 'langchain-langgraph.invoke',
          meta: {
            'span.kind': 'client',
            'component': 'langchain-langgraph'
          },
          metrics: {},
          error: 1
        }
      )

      let errorThrown = false
      let caughtError = null
      try {
        await testSetup.pregelInvokeError()
      } catch (err) {
        errorThrown = true
        caughtError = err
      }

      // Verify library behavior: error should be thrown when invalid input is passed
      if (!errorThrown) {
        throw new Error('Expected invoke to throw an error with invalid input')
      }
      if (!caughtError || typeof caughtError !== 'object') {
        throw new Error('Expected error to be an Error object')
      }

      return traceAssertion
    })
  })
})
