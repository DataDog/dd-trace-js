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
            'span.kind': 'client'
          },
          metrics: {}
        }
      )

      await testSetup.pregelInvoke()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = meta.agent.assertFirstTraceSpan(
        {
          name: 'langchain-langgraph.invoke',
          meta: {
            'span.kind': 'client'
          },
          metrics: {},
          error: 1
        }
      )

      try {
        await testSetup.pregelInvokeError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
