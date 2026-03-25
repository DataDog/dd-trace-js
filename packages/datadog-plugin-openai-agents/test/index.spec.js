'use strict'

const assert = require('node:assert/strict')

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { ANY_STRING, assertObjectContains } = require('../../../integration-tests/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('openai-agents', '@openai/agents-core', {
  category: 'generative-ai',
}, (meta) => {
  const { agent } = meta

  before(async () => {
    await testSetup.setup(meta.mod)
  })

  after(async () => {
    await testSetup.teardown()
  })

  describe('run() - agent.run', () => {
    // run() produces multiple spans (run + getResponse); use assertSomeTraces
    // to find the run span regardless of which span arrives first.
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const runSpan = traces.flat().find(s => s.name === 'openai-agents.run')
        assertObjectContains(runSpan, {
          name: 'openai-agents.run',
          service: ANY_STRING,
          resource: ANY_STRING,
          meta: {
            component: 'openai-agents',
            'span.kind': 'internal',
          },
        })
      })

      const result = await testSetup.run()
      assert.ok(result, 'run() should return a result object')
      assert.ok(result.finalOutput !== undefined, 'run() result should have finalOutput')

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const runSpan = traces.flat().find(s => s.name === 'openai-agents.run')
        assertObjectContains(runSpan, {
          name: 'openai-agents.run',
          meta: {
            component: 'openai-agents',
            'span.kind': 'internal',
            'error.type': 'Error',
            'error.message': 'Intentional error for testing',
            'error.stack': ANY_STRING,
          },
          error: 1,
        })
      })

      try {
        await testSetup.runError()
      } catch (err) {
        // errorAgent triggers an intentional error
      }

      return traceAssertion
    })
  })

  describe('getResponse() - model.request', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.getResponse',
          service: ANY_STRING,
          resource: ANY_STRING,
          meta: {
            component: 'openai-agents',
            'span.kind': 'client',
            'out.host': ANY_STRING,
            'ai.request.model': 'gpt-4',
            'ai.request.model_provider': 'openai',
            'openai.request.model': 'gpt-4',
          },
        }
      )

      const response = await testSetup.getResponse()
      assert.ok(response, 'getResponse() should return a response object')
      assert.ok(Array.isArray(response.output), 'getResponse() response should have output array')

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.getResponse',
          meta: {
            component: 'openai-agents',
            'span.kind': 'client',
            'out.host': ANY_STRING,
            'ai.request.model': 'gpt-4',
            'ai.request.model_provider': 'openai',
            'openai.request.model': 'gpt-4',
            'error.type': 'Error',
            'error.message': 'Intentional error for testing',
            'error.stack': ANY_STRING,
          },
          error: 1,
        }
      )

      try {
        await testSetup.getResponseError()
      } catch (err) {
        // Error is expected: the mock client throws to exercise the error path
      }

      return traceAssertion
    })
  })

  describe('getStreamedResponse() - model.stream', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.getStreamedResponse',
          service: ANY_STRING,
          resource: ANY_STRING,
          meta: {
            component: 'openai-agents',
            'span.kind': 'client',
            'out.host': ANY_STRING,
            'ai.request.model': 'gpt-4',
            'ai.request.model_provider': 'openai',
            'openai.request.model': 'gpt-4',
            'openai.request.stream': 'true',
          },
        }
      )

      await testSetup.getStreamedResponse()

      return traceAssertion
    })

    it('should generate span without error when stream errors during iteration', async () => {
      // For async generators, the orchestrion wraps the function call and finishes
      // the span when the iterator is returned. Errors during iteration occur AFTER
      // the span finishes, so the span shows error: 0.
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.getStreamedResponse',
          error: 0,
          meta: {
            component: 'openai-agents',
            'span.kind': 'client',
            'out.host': ANY_STRING,
            'ai.request.model': 'gpt-4',
            'ai.request.model_provider': 'openai',
            'openai.request.model': 'gpt-4',
            'openai.request.stream': 'true',
          },
        }
      )

      try {
        await testSetup.getStreamedResponseError()
      } catch (err) {
        // Error occurs during stream iteration, after span finishes
      }

      return traceAssertion
    })
  })

  describe('invokeFunctionTool() - tool.call', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.invokeFunctionTool',
          service: ANY_STRING,
          resource: ANY_STRING,
          meta: {
            component: 'openai-agents',
            'span.kind': 'internal',
          },
        }
      )

      const result = await testSetup.invokeFunctionTool()
      assert.ok(result !== undefined, 'invokeFunctionTool() should return a result')

      return traceAssertion
    })

    it('should generate span without error when tool error is non-fatal', async () => {
      // The library catches tool errors internally via toolErrorFunction and converts
      // them to return values (non-fatal). The span completes successfully.
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.invokeFunctionTool',
          error: 0,
          meta: {
            component: 'openai-agents',
            'span.kind': 'internal',
          },
        }
      )

      await testSetup.invokeFunctionToolError()

      return traceAssertion
    })
  })

  describe('onInvokeHandoff() - handoff', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.onInvokeHandoff',
          service: ANY_STRING,
          resource: ANY_STRING,
          meta: {
            component: 'openai-agents',
            'span.kind': 'internal',
          },
        }
      )

      await testSetup.onInvokeHandoff()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.onInvokeHandoff',
          meta: {
            component: 'openai-agents',
            'span.kind': 'internal',
            'error.type': ANY_STRING,
            'error.message': 'Handoff function expected non empty input',
            'error.stack': ANY_STRING,
          },
          error: 1,
        }
      )

      try {
        await testSetup.onInvokeHandoffError()
      } catch (err) {
        // ModelBehaviorError from empty input
      }

      return traceAssertion
    })
  })

  describe('runInputGuardrails() - guardrail.input', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.runInputGuardrails',
          service: ANY_STRING,
          resource: ANY_STRING,
          meta: {
            component: 'openai-agents',
            'span.kind': 'internal',
          },
        }
      )

      await testSetup.runInputGuardrails()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.runInputGuardrails',
          meta: {
            component: 'openai-agents',
            'span.kind': 'internal',
            'error.type': 'Error',
            'error.message': 'Intentional error for testing',
            'error.stack': ANY_STRING,
          },
          error: 1,
        }
      )

      try {
        await testSetup.runInputGuardrailsError()
      } catch (err) {
        // guardrail throws intentional error
      }

      return traceAssertion
    })
  })

  describe('runOutputGuardrails() - guardrail.output', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.runOutputGuardrails',
          service: ANY_STRING,
          resource: ANY_STRING,
          meta: {
            component: 'openai-agents',
            'span.kind': 'internal',
          },
        }
      )

      await testSetup.runOutputGuardrails()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.runOutputGuardrails',
          meta: {
            component: 'openai-agents',
            'span.kind': 'internal',
            'error.type': 'Error',
            'error.message': 'Intentional error for testing',
            'error.stack': ANY_STRING,
          },
          error: 1,
        }
      )

      try {
        await testSetup.runOutputGuardrailsError()
      } catch (err) {
        // guardrail throws intentional error
      }

      return traceAssertion
    })
  })
})
