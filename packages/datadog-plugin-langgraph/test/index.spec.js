'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('langgraph', '@langchain/langgraph', {
  category: 'llm'
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('Pregel.invoke() - invoke', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'langgraph.invoke',
          meta: {
            'span.kind': 'internal'
          }
        }
      )

      await testSetup.pregelInvoke()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'langgraph.invoke',
          meta: {
            'span.kind': 'internal',
            'error.type': 'Error',
            'error.message': 'Intentional error for testing'
          },
          error: 1
        }
      )

      try {
        await testSetup.pregelInvokeError()
      } catch (err) {
        // Ignore expected error
      }

      return traceAssertion
    })
  })

  describe('Pregel.stream() - stream', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'langgraph.stream',
          meta: {
            'span.kind': 'internal'
          }
        }
      )

      await testSetup.pregelStream()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'langgraph.stream',
          meta: {
            'span.kind': 'internal',
            'error.type': 'Error',
            'error.message': 'Intentional stream error for testing'
          },
          error: 1
        }
      )

      try {
        await testSetup.pregelStreamError()
      } catch (err) {
        // Ignore expected error
      }

      return traceAssertion
    })
  })
})
