'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { ANY_STRING, assertObjectContains } = require('../../../integration-tests/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('langgraph', '@langchain/langgraph', {
  category: 'llm',
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
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const invokeSpan = allSpans.find(span => span.name === 'langgraph.invoke')

        if (!invokeSpan) {
          throw new Error('langgraph.invoke span not found')
        }

        assertObjectContains(invokeSpan, {
          name: 'langgraph.invoke',
          meta: {
            'span.kind': 'internal',
            component: 'langgraph',
          },
        })
      })

      await testSetup.pregelInvoke()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const invokeSpan = allSpans.find(span => span.name === 'langgraph.invoke' && span.error === 1)

        if (!invokeSpan) {
          throw new Error('langgraph.invoke error span not found')
        }

        assertObjectContains(invokeSpan, {
          name: 'langgraph.invoke',
          error: 1,
          meta: {
            'span.kind': 'internal',
            component: 'langgraph',
            'error.type': ANY_STRING,
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
          },
        })
      })

      await testSetup.pregelInvokeError().catch(() => {})

      return traceAssertion
    })
  })

  describe('Pregel.stream() - stream', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const streamSpan = allSpans.find(span => span.name === 'langgraph.stream')

        if (!streamSpan) {
          throw new Error('langgraph.stream span not found')
        }

        assertObjectContains(streamSpan, {
          name: 'langgraph.stream',
          meta: {
            'span.kind': 'internal',
            component: 'langgraph',
          },
        })
      })

      await testSetup.pregelStream()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const streamSpan = allSpans.find(span => span.name === 'langgraph.stream' && span.error === 1)

        if (!streamSpan) {
          throw new Error('langgraph.stream error span not found')
        }

        assertObjectContains(streamSpan, {
          name: 'langgraph.stream',
          error: 1,
          meta: {
            'span.kind': 'internal',
            component: 'langgraph',
            'error.type': ANY_STRING,
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
          },
        })
      })

      await testSetup.pregelStreamError().catch(() => {})

      return traceAssertion
    })
  })
})
