'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('langgraph', '@langchain/langgraph', {
  additionalPlugins: ['langchain'],
  category: 'llm',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    const { tool } = meta.versionMod.get('@langchain/core/tools')
    const { z } = meta.versionMod.get('zod')
    await testSetup.setup(meta.mod, tool, z)
  })

  after(async () => {
    await testSetup.teardown()
  })

  beforeEach(async () => {
    await agent.load(['langgraph', 'langchain'])
  })

  afterEach(async () => {
    await agent.close()
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
        assert.ok(
          Object.hasOwn(streamSpan.meta, 'error.type'),
          `Available keys: ${inspect(Object.keys(streamSpan.meta))}`
        )
        assert.ok(
          Object.hasOwn(streamSpan.meta, 'error.message'),
          `Available keys: ${inspect(Object.keys(streamSpan.meta))}`
        )
        assert.ok(
          Object.hasOwn(streamSpan.meta, 'error.stack'),
          `Available keys: ${inspect(Object.keys(streamSpan.meta))}`
        )
      })

      await testSetup.pregelStreamError().catch(() => {})

      return traceAssertion
    })

    it('should not mark graph interrupts as errors', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const toolSpan = allSpans.find(span => span.resource?.endsWith('.ask_for_approval'))

        assert.ok(toolSpan)
        assert.strictEqual(toolSpan.error, 0)
        assert.strictEqual(Object.hasOwn(toolSpan.meta, 'error.type'), false)
        assert.strictEqual(Object.hasOwn(toolSpan.meta, 'error.message'), false)
        assert.strictEqual(Object.hasOwn(toolSpan.meta, 'error.stack'), false)
      })

      const { resumed, suspended } = await testSetup.graphInterrupt()

      assert.strictEqual(suspended.__interrupt__.length, 1)
      assert.strictEqual(resumed.result, 'The action was approved.')
      return traceAssertion
    })
  })
})
