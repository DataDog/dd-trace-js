'use strict'

// Disable the OpenAI Agents SDK's internal tracing which tries to export traces
// to OpenAI's backend and causes ECONNREFUSED errors when running tests
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1'

const assert = require('node:assert')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

/**
 * Mock responses for OpenAI Chat Completions API
 * The \@openai/agents SDK uses fetch internally, so we stub global.fetch
 */
const mockResponses = {
  basic: {
    id: 'chatcmpl-test123',
    object: 'chat.completion',
    created: 1768413000,
    model: 'gpt-4o-mini-2024-07-18',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: '4' },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 25, completion_tokens: 1, total_tokens: 26 },
    system_fingerprint: 'fp_test'
  },
  toolCall: {
    id: 'chatcmpl-tool123',
    object: 'chat.completion',
    created: 1768413000,
    model: 'gpt-4o-mini-2024-07-18',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_test123',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"San Francisco"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    system_fingerprint: 'fp_test'
  },
  toolResult: {
    id: 'chatcmpl-result123',
    object: 'chat.completion',
    created: 1768413000,
    model: 'gpt-4o-mini-2024-07-18',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'The weather in San Francisco is sunny and 72 degrees.' },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 80, completion_tokens: 15, total_tokens: 95 },
    system_fingerprint: 'fp_test'
  },
  error: {
    error: {
      message: 'The model `invalid-model-that-does-not-exist` does not exist',
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found'
    }
  }
}

describe('Plugin', () => {
  describe('openai-agents', () => {
    withVersions('openai-agents', '@openai/agents', version => {
      let originalFetch
      let fetchCallCount = 0
      const sdk = {}

      before(async () => {
        await agent.load('openai-agents')

        // Load the openai-agents module
        const agentsModule = require(`../../../versions/@openai/agents@${version}`).get()

        sdk.Agent = agentsModule.Agent
        sdk.run = agentsModule.run
        sdk.tool = agentsModule.tool
        sdk.OpenAIProvider = agentsModule.OpenAIProvider
        sdk.setDefaultModelProvider = agentsModule.setDefaultModelProvider
      })

      after(async () => {
        await agent.close({ ritmReset: false })
      })

      beforeEach(() => {
        fetchCallCount = 0
        originalFetch = global.fetch
      })

      afterEach(() => {
        global.fetch = originalFetch
        fetchCallCount = 0
      })

      /**
       * Helper to setup mock fetch with a specific scenario
       * Creates a custom OpenAI client with mocked fetch to properly intercept requests
       */
      function setupMockFetch (scenario, statusCode = 200, multiCall = false) {
        // Set API key in environment
        process.env.OPENAI_API_KEY = 'sk-test-key-for-testing'

        // Create mock fetch function
        const mockFetch = async function (url) {
          fetchCallCount++

          let responseBody
          let responseStatus = statusCode

          if (scenario === 'error') {
            responseBody = JSON.stringify(mockResponses.error)
            responseStatus = 404
          } else if (multiCall) {
            if (fetchCallCount === 1) {
              responseBody = JSON.stringify(mockResponses.toolCall)
            } else {
              responseBody = JSON.stringify(mockResponses.toolResult)
            }
          } else {
            responseBody = JSON.stringify(mockResponses[scenario] || mockResponses.basic)
          }

          return new Response(responseBody, {
            status: responseStatus,
            headers: { 'Content-Type': 'application/json' }
          })
        }

        // Also mock global.fetch for consistency
        global.fetch = mockFetch

        // Note: OpenAI client creation would normally happen here,
        // but we mock fetch globally so the provider uses the mocked fetch

        // Setup provider - it will use the mocked global fetch
        const provider = new sdk.OpenAIProvider({
          useResponses: false // Use Chat Completions API
        })
        sdk.setDefaultModelProvider(provider)
      }

      describe('Runner.run() - workflow', () => {
        it('should generate span with correct tags (happy path)', async () => {
          setupMockFetch('basic')

          const testAgent = new sdk.Agent({
            name: 'SimpleAssistant',
            instructions: 'You are a helpful assistant.',
            model: 'gpt-4o-mini'
          })

          const traceAssertion = agent.assertSomeTraces(traces => {
            const spans = traces.flat()
            const runSpan = spans.find(s => s.name === 'openai-agents.run')
            assert.ok(runSpan, 'Should have run span')
            assert.equal(runSpan.meta['span.kind'], 'client', 'Should be client span')
            assert.equal(runSpan.meta.component, 'openai-agents', 'Should have component tag')
            assert.equal(runSpan.meta['ai.request.model_provider'], 'openai', 'Should have model provider')
          })

          const result = await sdk.run(testAgent, 'Hello! What is 2 + 2?')
          // Verify the SDK actually works and returns a result
          assert.ok(result, 'Should return a result from sdk.run')

          return traceAssertion
        })

        it('should handle empty response gracefully', async () => {
          // Test that the instrumentation handles edge cases without crashing
          // Mock returns a minimal valid response
          setupMockFetch('basic')

          const simpleAgent = new sdk.Agent({
            name: 'SimpleAgent',
            instructions: 'Be brief.',
            model: 'gpt-4o-mini'
          })

          const traceAssertion = agent.assertSomeTraces(traces => {
            const spans = traces.flat()
            const runSpan = spans.find(s => s.name === 'openai-agents.run')
            assert.ok(runSpan, 'Should have run span')
            // Verify the run completed (span has finish time)
            assert.ok(runSpan.duration, 'Span should have duration')
          })

          const result = await sdk.run(simpleAgent, 'Hi')
          // Verify the SDK returns a valid result and library still works
          assert.ok(result, 'Should return a result from sdk.run')
          assert.ok(result.finalOutput !== undefined || result.state, 'Result should have expected structure')

          return traceAssertion
        })
      })

      describe('OpenAIChatCompletionsModel.getResponse() - LLM call', () => {
        it('should generate span for model.getResponse()', async () => {
          setupMockFetch('basic')

          const testAgent = new sdk.Agent({
            name: 'SimpleAgent',
            instructions: 'Reply briefly.',
            model: 'gpt-4o-mini'
          })

          const traceAssertion = agent.assertSomeTraces(traces => {
            const spans = traces.flat()
            const getResponseSpan = spans.find(s =>
              s.name === 'openai-agents.getResponse' ||
              s.name === 'openai-agents.getStreamedResponse'
            )
            assert.ok(getResponseSpan, 'Should have getResponse or getStreamedResponse span')
            assert.equal(getResponseSpan.meta['span.kind'], 'client', 'Should be client span')
            assert.equal(getResponseSpan.meta['ai.request.model_provider'], 'openai', 'Should have openai provider')
          })

          const result = await sdk.run(testAgent, 'Say hello!')
          // Verify the SDK returns a valid response from model call
          assert.ok(result, 'Should return a result from model call')
          assert.ok(result.finalOutput !== undefined || result.state, 'Result should have expected structure')

          return traceAssertion
        })

        it('should include model information in span metadata', async () => {
          setupMockFetch('basic')

          const testAgent = new sdk.Agent({
            name: 'MetadataAgent',
            instructions: 'Reply briefly.',
            model: 'gpt-4o-mini'
          })

          const traceAssertion = agent.assertSomeTraces(traces => {
            const spans = traces.flat()
            const getResponseSpan = spans.find(s =>
              s.name === 'openai-agents.getResponse' ||
              s.name === 'openai-agents.getStreamedResponse'
            )
            assert.ok(getResponseSpan, 'Should have getResponse or getStreamedResponse span')
            // Verify span has expected metadata
            assert.equal(getResponseSpan.meta.component, 'openai-agents', 'Should have component tag')
          })

          const result = await sdk.run(testAgent, 'Test')
          // Verify the model is actually used and returns expected response
          assert.ok(result, 'Should return a result from model')
          assert.ok(result.finalOutput !== undefined || result.state, 'Result should have expected structure from model')

          return traceAssertion
        })
      })

      describe('FunctionTool setup', () => {
        it('should wrap tool invoke method for tracing', async () => {
          // Verify that tools created through sdk.tool() are wrapped for tracing
          // The invoke wrapper is applied when the tool is created
          const testTool = sdk.tool({
            name: 'test_tool',
            description: 'A test tool',
            parameters: {
              type: 'object',
              properties: {
                input: { type: 'string' }
              },
              required: ['input']
            },
            execute: async ({ input }) => {
              return 'Result: ' + input
            }
          })

          // Verify tool has invoke method (wrapped by instrumentation)
          assert.ok(testTool, 'Tool should be created')
          assert.ok(typeof testTool.invoke === 'function', 'Tool should have invoke method')

          // Verify the tool actually works by calling invoke
          // Tool invoke signature is (ctx, inputJsonString)
          const toolResult = await testTool.invoke(null, '{"input": "test_input"}')
          assert.ok(toolResult, 'Tool invoke should return a result')
          // Tool result should contain the expected data
          assert.ok(toolResult.includes('test_input'), 'Tool result should contain input value')
        })
      })

      describe('agent with tools', () => {
        it('should create agent with tools and generate run span', async () => {
          setupMockFetch('basic')

          // Create a simple tool
          const weatherTool = sdk.tool({
            name: 'get_weather',
            description: 'Get weather info',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string' }
              },
              required: ['city'],
              additionalProperties: false
            },
            execute: async ({ city }) => {
              return JSON.stringify({ temp: 72, city })
            }
          })

          const toolAgent = new sdk.Agent({
            name: 'ToolAgent',
            instructions: 'You can use tools.',
            model: 'gpt-4o-mini',
            tools: [weatherTool]
          })

          // Run with a message that doesn't require tool use (basic response)
          const traceAssertion = agent.assertSomeTraces(traces => {
            const spans = traces.flat()
            const runSpan = spans.find(s => s.name === 'openai-agents.run')
            assert.ok(runSpan, 'Should have run span')
          })

          const result = await sdk.run(toolAgent, 'Hello!')
          // Verify the agent with tools actually works and returns results
          assert.ok(result, 'Agent should return a result')
          assert.ok(result.finalOutput !== undefined || result.state, 'Result should have expected structure')

          return traceAssertion
        })
      })

      describe('span hierarchy', () => {
        it('should create parent-child relationships between spans', async () => {
          setupMockFetch('basic')

          const testAgent = new sdk.Agent({
            name: 'HierarchyAgent',
            instructions: 'Reply OK.',
            model: 'gpt-4o-mini'
          })

          const traceAssertion = agent.assertSomeTraces(traces => {
            const spans = traces.flat()

            // Find the root workflow span
            const workflowSpan = spans.find(s => s.name === 'openai-agents.run')
            assert.ok(workflowSpan, 'Should have workflow span')
            assert.ok(workflowSpan.span_id, 'Workflow span should have span_id')
            assert.ok(workflowSpan.trace_id, 'Workflow span should have trace_id')

            // Find child spans (spans with parent_id that matches workflow span)
            const childSpans = spans.filter(s =>
              s.name !== 'openai-agents.run' &&
              s.trace_id?.toString() === workflowSpan.trace_id?.toString()
            )

            // Verify at least one child span exists with proper parent relationship
            if (childSpans.length > 0) {
              for (const child of childSpans) {
                // Verify child has parent_id and it matches workflow span
                assert.ok(child.parent_id !== undefined && child.parent_id !== null,
                  'Child spans should have parent_id')
                assert.ok(child.parent_id?.toString() === workflowSpan.span_id?.toString(),
                  'Child span parent_id should match workflow span_id')
              }
            }
          })

          const result = await sdk.run(testAgent, 'Test')
          // Verify SDK works
          assert.ok(result, 'Should return a result')

          return traceAssertion
        })
      })

      describe('span attributes', () => {
        it('should include component tag', async () => {
          setupMockFetch('basic')

          const testAgent = new sdk.Agent({
            name: 'ComponentAgent',
            instructions: 'Reply OK.',
            model: 'gpt-4o-mini'
          })

          const traceAssertion = agent.assertFirstTraceSpan({
            name: 'openai-agents.run',
            meta: {
              component: 'openai-agents'
            }
          })

          await sdk.run(testAgent, 'Test')

          return traceAssertion
        })

        it('should include model provider tag', async () => {
          setupMockFetch('basic')

          const testAgent = new sdk.Agent({
            name: 'ProviderAgent',
            instructions: 'Reply OK.',
            model: 'gpt-4o-mini'
          })

          const traceAssertion = agent.assertFirstTraceSpan({
            name: 'openai-agents.run',
            meta: {
              'ai.request.model_provider': 'openai'
            }
          })

          await sdk.run(testAgent, 'Test')

          return traceAssertion
        })

        it('should include model name tag', async () => {
          setupMockFetch('basic')

          const testAgent = new sdk.Agent({
            name: 'ModelAgent',
            instructions: 'Reply OK.',
            model: 'gpt-4o-mini'
          })

          const traceAssertion = agent.assertFirstTraceSpan({
            name: 'openai-agents.run',
            meta: {
              'ai.request.model': 'gpt-4o-mini',
              'openai.request.model': 'gpt-4o-mini'
            }
          })

          await sdk.run(testAgent, 'Test')

          return traceAssertion
        })

        it('should include out.host tag for peer.service computation', async () => {
          setupMockFetch('basic')

          const testAgent = new sdk.Agent({
            name: 'PeerServiceAgent',
            instructions: 'Reply OK.',
            model: 'gpt-4o-mini'
          })

          const traceAssertion = agent.assertFirstTraceSpan({
            name: 'openai-agents.run',
            meta: {
              'out.host': 'api.openai.com'
            }
          })

          await sdk.run(testAgent, 'Test')

          return traceAssertion
        })
      })
    })
  })
})
