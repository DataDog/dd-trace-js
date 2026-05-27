'use strict'

const assert = require('node:assert/strict')

const sinon = require('sinon')

const { ANY_STRING } = require('../../../integration-tests/helpers')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('anthropic-ai-claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', {
  category: 'generative-ai',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('query() - agent.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'anthropic-ai-claude-agent-sdk.query',
          meta: {
            'span.kind': 'client',
            component: 'anthropic-ai-claude-agent-sdk',
            'out.host': 'api.anthropic.com',
          },
        }
      )

      const result = await testSetup.query()
      // Verify instrumentation did not break the library's public contract:
      // `query()` must still return an async iterable that exposes `close()`.
      assert.ok(result.isAsyncIterable, 'query() should return an async iterable')
      assert.ok(result.hasClose, 'query() result should expose close()')

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'anthropic-ai-claude-agent-sdk.query',
          meta: {
            'span.kind': 'client',
            component: 'anthropic-ai-claude-agent-sdk',
            'out.host': 'api.anthropic.com',
            'error.type': ANY_STRING,
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
          },
          error: 1,
        }
      )

      let caught
      try {
        await testSetup.queryError()
      } catch (err) {
        caught = err
      }
      // Assert the specific error type we expect so an unexpected error
      // (test-setup crash, wrong method invoked, etc.) does not pass
      // silently. queryError() supplies a non-AbortController value, which
      // makes the SDK throw a TypeError synchronously inside `tj$`.
      assert.ok(caught, 'queryError() should throw')
      assert.strictEqual(caught.name, 'TypeError')

      return traceAssertion
    })
  })

  describe('peer service', () => {
    let computeStub

    beforeEach(() => {
      const plugin = meta.tracer._pluginManager._pluginsByName['anthropic-ai-claude-agent-sdk']
      computeStub = sinon.stub(plugin._tracerConfig, 'spanComputePeerService').value(true)
    })

    afterEach(() => {
      computeStub.restore()
    })

    it('should compute peer.service from out.host precursor on the query span', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'anthropic-ai-claude-agent-sdk.query',
          meta: {
            'span.kind': 'client',
            component: 'anthropic-ai-claude-agent-sdk',
            'out.host': 'api.anthropic.com',
            'peer.service': 'api.anthropic.com',
            '_dd.peer.service.source': 'out.host',
          },
        }
      )

      await testSetup.query()

      return traceAssertion
    })
  })
})
