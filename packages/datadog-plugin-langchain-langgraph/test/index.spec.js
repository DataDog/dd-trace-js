'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { ANY_STRING } = require('../../../integration-tests/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('langchain-langgraph', '@langchain/langgraph', {
  category: 'orchestration',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('Pregel.stream() - workflow.stream', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'langchain-langgraph.stream',
          meta: {
            'span.kind': 'internal',
            component: 'langchain-langgraph',
          },
          metrics: {},
        }
      )

      await testSetup.pregelStream()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'langchain-langgraph.stream',
          meta: {
            'span.kind': 'internal',
            'error.type': 'Error',
            'error.message': 'Intentional error for testing',
            'error.stack': ANY_STRING,
            component: 'langchain-langgraph',
          },
          metrics: {},
          error: 1,
        }
      )

      try {
        await testSetup.pregelStreamError()
      } catch (err) {
      }

      return traceAssertion
    })
  })
})
