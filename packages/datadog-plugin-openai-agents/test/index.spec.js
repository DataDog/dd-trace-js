'use strict'

const assert = require('assert')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('openai-agents', '@openai/agents-core', testSetup, {
  category: 'llm'
}, (meta) => {
  const { agent } = meta

  describe('Runner.run() - agent.run', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.run',
          meta: {
            'span.kind': 'internal',
            component: 'openai-agents',
            'openai-agents.agent.name': 'TestAgent',
            'openai-agents.tools': 'get_weather',
            'openai-agents.turn_count': '1'
          }
        }
      )

      // Execute operation via test setup
      const result = await testSetup.runnerRun()

      // Assert on operation result
      assert(result, 'runnerRun should return a result')
      assert(result.state, 'result should have state')

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.run',
          meta: {
            'span.kind': 'internal',
            component: 'openai-agents'
          },
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.runnerRunError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('FunctionTool.invoke() - tool.execute', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.invoke',
          meta: {
            'span.kind': 'internal',
            component: 'openai-agents',
            'openai-agents.tool.name': 'fresh_weather',
            'openai-agents.tool.input': '{"city":"New York"}'
          }
        }
      )

      // Execute operation via test setup
      const result = await testSetup.functiontoolInvoke()

      // Assert on operation result
      assert(result, 'functiontoolInvoke should return a result')
      assert(typeof result === 'string', 'result should be a string')
      assert(result.includes('Weather'), 'result should include weather information')

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.invoke',
          meta: {
            'span.kind': 'internal',
            component: 'openai-agents'
          },
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.functiontoolInvokeError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('OpenAIChatCompletionsModel.getResponse() - llm.chat', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.getResponse',
          meta: {
            'span.kind': 'client',
            component: 'openai-agents'
          }
        }
      )

      // Execute operation via test setup
      const response = await testSetup.openaichatcompletionsmodelGetresponse()

      // Assert on operation result
      assert(response, 'openaichatcompletionsmodelGetresponse should return a response')
      assert(response.usage, 'response should have usage data')

      return traceAssertion
    })

    it('should set out.host for peer service detection', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.getResponse',
          meta: {
            'span.kind': 'client',
            component: 'openai-agents',
            'out.host': 'api.openai.com'
          }
        }
      )

      await testSetup.openaichatcompletionsmodelGetresponse()

      return traceAssertion
    })

    it('should capture request model name', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.getResponse',
          meta: {
            'span.kind': 'client',
            component: 'openai-agents',
            'openai-agents.request.model': 'gpt-4'
          }
        }
      )

      await testSetup.openaichatcompletionsmodelGetresponse()

      return traceAssertion
    })

    it('should capture token usage', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.getResponse',
          meta: {
            'span.kind': 'client',
            component: 'openai-agents',
            'openai-agents.response.usage.input_tokens': '10',
            'openai-agents.response.usage.output_tokens': '5',
            'openai-agents.response.usage.total_tokens': '15'
          }
        }
      )

      await testSetup.openaichatcompletionsmodelGetresponse()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'openai-agents.getResponse',
          meta: {
            'span.kind': 'client',
            component: 'openai-agents'
          },
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.openaichatcompletionsmodelGetresponseError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
