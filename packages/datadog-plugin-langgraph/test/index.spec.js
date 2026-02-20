'use strict'

const assert = require('node:assert/strict')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
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

  beforeEach(async () => {
    await agent.load('langgraph')
  })

  afterEach(async () => {
    await agent.close({ ritmReset: false })
  })

  describe('Pregel.invoke() - invoke', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const invokeSpan = allSpans.find(span => span.name === 'LangGraph')

        if (!invokeSpan) {
          throw new Error('LangGraph span not found')
        }

        assert.equal(invokeSpan.name, 'LangGraph')
        assert.equal(invokeSpan.meta['span.kind'], 'internal')
        assert.equal(invokeSpan.meta.component, 'langgraph')
      })

      await testSetup.pregelInvoke()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const invokeSpan = allSpans.find(span => span.name === 'LangGraph' && span.error === 1)

        if (!invokeSpan) {
          throw new Error('LangGraph error span not found')
        }
        assert.equal(invokeSpan.name, 'LangGraph')
        assert.equal(invokeSpan.error, 1)
        assert.equal(invokeSpan.meta['span.kind'], 'internal')
        assert.equal(invokeSpan.meta.component, 'langgraph')
        assert.ok(Object.hasOwn(invokeSpan.meta, 'error.type'))
        assert.ok(Object.hasOwn(invokeSpan.meta, 'error.message'))
        assert.ok(Object.hasOwn(invokeSpan.meta, 'error.stack'))
      })

      await testSetup.pregelInvokeError().catch(() => {})

      return traceAssertion
    })
  })

  describe('Pregel.stream() - stream', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const streamSpan = allSpans.find(span => span.name === 'LangGraph')

        if (!streamSpan) {
          throw new Error('LangGraph span not found')
        }

        assert.equal(streamSpan.name, 'LangGraph')
        assert.equal(streamSpan.meta['span.kind'], 'internal')
        assert.equal(streamSpan.meta.component, 'langgraph')
      })

      await testSetup.pregelStream()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const streamSpan = allSpans.find(span => span.name === 'LangGraph' && span.error === 1)

        if (!streamSpan) {
          throw new Error('LangGraph error span not found')
        }

        assert.equal(streamSpan.name, 'LangGraph')
        assert.equal(streamSpan.error, 1)
        assert.equal(streamSpan.meta['span.kind'], 'internal')
        assert.equal(streamSpan.meta.component, 'langgraph')
        assert.ok(Object.hasOwn(streamSpan.meta, 'error.type'))
        assert.ok(Object.hasOwn(streamSpan.meta, 'error.message'))
        assert.ok(Object.hasOwn(streamSpan.meta, 'error.stack'))
      })

      await testSetup.pregelStreamError().catch(() => {})

      return traceAssertion
    })
  })
})
