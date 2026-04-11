'use strict'

const assert = require('node:assert/strict')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('openai-agents', '@openai/agents', {
  category: 'generative-ai',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('run() - top-level convenience function', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const runSpan = allSpans.find(span => span.name === 'openai-agents.run')

        assert.ok(runSpan, 'Expected to find an openai-agents.run span')
        assert.equal(runSpan.meta['span.kind'], 'internal')
        assert.equal(runSpan.meta.component, 'openai-agents')
        assert.equal(runSpan.error, 0)
      })

      await testSetup.run()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const errorSpan = allSpans.find(span => span.name === 'openai-agents.run' && span.error === 1)

        assert.ok(errorSpan, 'Expected to find an openai-agents.run error span')
        assert.equal(errorSpan.error, 1)
        assert.equal(errorSpan.meta['span.kind'], 'internal')
        assert.equal(errorSpan.meta.component, 'openai-agents')
        assert.ok(Object.hasOwn(errorSpan.meta, 'error.type'), 'Expected error.type tag')
        assert.ok(Object.hasOwn(errorSpan.meta, 'error.message'), 'Expected error.message tag')
        assert.ok(Object.hasOwn(errorSpan.meta, 'error.stack'), 'Expected error.stack tag')
      })

      try {
        await testSetup.runError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Runner.run() - class method', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const runSpan = allSpans.find(span => span.name === 'openai-agents.run')

        assert.ok(runSpan, 'Expected to find an openai-agents.run span')
        assert.equal(runSpan.meta['span.kind'], 'internal')
        assert.equal(runSpan.meta.component, 'openai-agents')
        assert.equal(runSpan.error, 0)
      })

      await testSetup.runnerRun()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()
        const errorSpan = allSpans.find(span => span.name === 'openai-agents.run' && span.error === 1)

        assert.ok(errorSpan, 'Expected to find an openai-agents.run error span')
        assert.equal(errorSpan.error, 1)
        assert.equal(errorSpan.meta['span.kind'], 'internal')
        assert.equal(errorSpan.meta.component, 'openai-agents')
        assert.ok(Object.hasOwn(errorSpan.meta, 'error.type'), 'Expected error.type tag')
        assert.ok(Object.hasOwn(errorSpan.meta, 'error.message'), 'Expected error.message tag')
        assert.ok(Object.hasOwn(errorSpan.meta, 'error.stack'), 'Expected error.stack tag')
      })

      try {
        await testSetup.runnerRunError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
