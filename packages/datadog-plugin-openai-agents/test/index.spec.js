'use strict'

const assert = require('node:assert/strict')

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')
const { ANY_STRING, assertObjectContains } = require('../../../integration-tests/helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

function findSpan (traces, predicate) {
  return traces.flat().find(predicate)
}

/**
 * Integration test suite for the processor-driven openai-agents integration.
 *
 * agents-core only creates Span objects inside real agent-execution flows
 * (run(), withTrace(), withAgentSpan(), withResponseSpan(), etc.) — direct
 * calls to helpers like invokeFunctionTool / onInvokeHandoff / runToolGuardrails
 * do NOT emit Spans because agents-core's span creation happens in the runner,
 * not in those helpers. The tests below exercise real flows.
 */
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

  describe('run() — single-agent workflow', () => {
    it('emits a workflow span with correct component/kind tags', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const workflowSpan = findSpan(traces, s => s.name === 'Agent workflow')
        assertObjectContains(workflowSpan, {
          name: 'Agent workflow',
          service: ANY_STRING,
          meta: {
            component: 'openai-agents',
            'span.kind': 'internal',
          },
        })
      })

      const result = await testSetup.run()
      assert.ok(result, 'run() should return a result object')
      assert.ok(result.finalOutput !== undefined, 'run() should have finalOutput')

      return traceAssertion
    })

    it('emits an agent span named after the running agent', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const agentSpan = findSpan(traces, s => s.name === 'test_agent')
        assertObjectContains(agentSpan, {
          name: 'test_agent',
          meta: { component: 'openai-agents' },
        })
      })

      await testSetup.run()
      return traceAssertion
    })

    it('emits a response span under the agent span', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const responseSpan = findSpan(traces, s => s.name === 'openai_agents.response')
        assertObjectContains(responseSpan, {
          name: 'openai_agents.response',
          meta: {
            component: 'openai-agents',
            'span.kind': 'client',
          },
        })
      })

      await testSetup.run()
      return traceAssertion
    })

    it('finishes the workflow span even when the underlying agent throws', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const workflowSpan = findSpan(traces, s => s.name === 'Agent workflow')
        assertObjectContains(workflowSpan, {
          name: 'Agent workflow',
          meta: { component: 'openai-agents' },
        })
      })

      try {
        await testSetup.runError()
      } catch (err) {
        // errorAgent triggers an intentional error from the mocked model
      }

      return traceAssertion
    })
  })

  describe('multi-agent handoff hierarchy', () => {
    // This was the original gap flagged by the PR reviewer — with the
    // orchestrion-driven path we could not express per-agent parent/child
    // relationships during a handoff. The processor resolves parents from
    // agents-core's own parentId chain, so the dd-trace hierarchy should
    // mirror the agents-core hierarchy exactly.
    it('nests agent_b under the handoff span under agent_a under the workflow', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const flat = traces.flat()

        const workflow = flat.find(s => s.name === 'handoff-test')
        const agentA = flat.find(s => s.name === 'agent_a')
        const handoff = flat.find(s => s.name === 'transfer_to_agent_b')
        const agentB = flat.find(s => s.name === 'agent_b')

        assert.ok(workflow, 'expected a workflow span named handoff-test')
        assert.ok(agentA, 'expected an agent span named agent_a')
        assert.ok(handoff, 'expected a handoff span named transfer_to_agent_b')
        assert.ok(agentB, 'expected an agent span named agent_b')

        assert.equal(agentA.parent_id.toString(), workflow.span_id.toString(),
          'agent_a should be a child of the workflow span')
        assert.equal(handoff.parent_id.toString(), agentA.span_id.toString(),
          'handoff should be a child of agent_a')
        assert.equal(agentB.parent_id.toString(), handoff.span_id.toString(),
          'agent_b should be a child of the handoff span')
      })

      await testSetup.multiAgentHandoff()
      return traceAssertion
    })
  })

  describe('model calls (getResponse, getStreamedResponse)', () => {
    // Both methods are wrapped in withTrace() by test-setup so agents-core
    // emits a real response Span via withResponseSpan internally.

    it('emits a response span for getResponse()', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const responseSpan = findSpan(traces, s => s.name === 'openai_agents.response')
        assertObjectContains(responseSpan, {
          name: 'openai_agents.response',
          meta: {
            component: 'openai-agents',
            'span.kind': 'client',
          },
        })
      })

      const response = await testSetup.getResponse()
      assert.ok(response, 'getResponse() should return a response object')
      assert.ok(Array.isArray(response.output), 'response should have output array')

      return traceAssertion
    })

    it('emits a response span for getStreamedResponse()', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        const responseSpan = findSpan(traces, s => s.name === 'openai_agents.response')
        assertObjectContains(responseSpan, {
          name: 'openai_agents.response',
          meta: {
            component: 'openai-agents',
            'span.kind': 'client',
          },
        })
      })

      await testSetup.getStreamedResponse()
      return traceAssertion
    })
  })
})
