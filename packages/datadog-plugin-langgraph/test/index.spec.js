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

  describe('Pregel.stream() - stream', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const streamSpan = allSpans.find(span => span.name === 'LangGraph')

        assert.ok(streamSpan)

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

        assert.ok(streamSpan)

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
