'use strict'

const assert = require('node:assert/strict')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('langchain-langgraph', '@langchain/langgraph', {
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
      const checkTraces = agent.assertSomeTraces(traces => {
        const spans = traces[0]
        const invokeSpan = spans.find(s => s.name === 'langchain-langgraph.invoke')
        assert.ok(invokeSpan, 'Expected to find langchain-langgraph.invoke span')
        assert.strictEqual(invokeSpan.meta.component, 'langchain-langgraph')
        assert.strictEqual(invokeSpan.meta['span.kind'], 'client')
      })

      await testSetup.pregelInvoke()

      return checkTraces
    })

    it('should generate span with error tags (error path)', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const spans = traces[0]
        const invokeSpan = spans.find(s => s.name === 'langchain-langgraph.invoke')
        assert.ok(invokeSpan, 'Expected to find langchain-langgraph.invoke span')
        assert.strictEqual(invokeSpan.meta.component, 'langchain-langgraph')
        assert.strictEqual(invokeSpan.meta['span.kind'], 'client')
        assert.strictEqual(invokeSpan.error, 1)
        assert.ok(invokeSpan.meta['error.message'], 'Expected error.message')
        assert.ok(invokeSpan.meta['error.type'], 'Expected error.type')
      })

      try {
        await testSetup.pregelInvokeError()
      } catch (err) {
        // Intentionally caught
      }

      return checkTraces
    })
  })

  describe('Pregel.stream() - stream', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const spans = traces[0]
        const streamSpan = spans.find(s => s.name === 'langchain-langgraph.stream')
        assert.ok(streamSpan, 'Expected to find langchain-langgraph.stream span')
        assert.strictEqual(streamSpan.meta.component, 'langchain-langgraph')
        assert.strictEqual(streamSpan.meta['span.kind'], 'client')
      })

      await testSetup.pregelStream()

      return checkTraces
    })

    it('should generate span with error tags (error path)', async () => {
      const checkTraces = agent.assertSomeTraces(traces => {
        const spans = traces[0]
        const streamSpan = spans.find(s => s.name === 'langchain-langgraph.stream')
        assert.ok(streamSpan, 'Expected to find langchain-langgraph.stream span')
        assert.strictEqual(streamSpan.meta.component, 'langchain-langgraph')
        assert.strictEqual(streamSpan.meta['span.kind'], 'client')
        assert.strictEqual(streamSpan.error, 1)
        assert.ok(streamSpan.meta['error.message'], 'Expected error.message')
        assert.ok(streamSpan.meta['error.type'], 'Expected error.type')
      })

      try {
        await testSetup.pregelStreamError()
      } catch (err) {
        // Intentionally caught
      }

      return checkTraces
    })
  })
})
