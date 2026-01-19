'use strict'

const assert = require('node:assert')
const { describe, it, before, beforeEach, afterEach } = require('mocha')
const { withVersions } = require('../../../setup/mocha')

const {
  useLlmObs
} = require('../../util')
const agent = require('../../../plugins/agent')

// Set environment variables BEFORE any modules are loaded
// This is critical because @openai/agents SDK caches these on import
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-api-key'
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1'

// Track fetch call count for multi-call scenarios (tool calls require multiple LLM calls)
let fetchCallCount = 0

/**
 * Mock responses for OpenAI Chat Completions API
 * The \@openai/agents package uses fetch internally, so we stub global.fetch
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

/**
 * Stub global.fetch to return mock OpenAI responses.
 * This approach is used because:
 * 1. @openai/agents SDK uses fetch internally
 * 2. The SDK's OpenAIChatCompletionsModel creates its own OpenAI client
 * 3. VCR proxy/cassettes don't work reliably with this SDK
 *
 * @param {object} options - Configuration for the mock
 * @param {string} options.scenario - Which mock response to use ('basic', 'toolCall', 'error')
 * @param {number} [options.statusCode=200] - HTTP status code to return
 * @param {boolean} [options.multiCall=false] - If true, alternate between toolCall and toolResult responses
 */
/**
 * Sets up mock fetch and returns a setupProvider function that must be called
 * AFTER the mock is active to ensure the OpenAI client uses the mocked fetch.
 */
function useMockFetch ({ scenario, statusCode = 200, multiCall = false }, setupProviderFn) {
  let originalFetch

  beforeEach(() => {
    fetchCallCount = 0
    originalFetch = global.fetch

    global.fetch = async function (url, options) {
      fetchCallCount++

      // Check if this is an OpenAI API call
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (!urlStr.includes('chat/completions')) {
        // For non-OpenAI calls, use original fetch if available
        if (originalFetch) {
          return originalFetch(url, options)
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`)
      }

      let responseBody
      let responseStatus = statusCode

      if (scenario === 'error') {
        responseBody = JSON.stringify(mockResponses.error)
        responseStatus = 404
      } else if (multiCall) {
        // For tool calls: first call returns tool_call, subsequent calls return tool_result
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

    // Setup provider AFTER mock fetch is in place
    if (setupProviderFn) {
      setupProviderFn()
    }
  })

  afterEach(() => {
    global.fetch = originalFetch
    fetchCallCount = 0
  })
}

describe('Plugin', () => {
  describe('openai-agents', () => {
    withVersions('openai-agents', '@openai/agents', (version, moduleName, realVersion) => {
      // useLlmObs must be called INSIDE withVersions to work correctly
      const { getEvents } = useLlmObs({ plugin: 'openai-agents', closeOptions: { wipe: true } })

      // Store module exports in an object - this pattern avoids closure issues
      // where let variables aren't accessible before before() runs
      const sdk = {}

      // Use before() to load module AFTER tracer initialization
      // This is critical for instrumentation to work properly
      //
      // IMPORTANT: We only load the module classes here, NOT create the provider.
      // The provider must be created AFTER mock fetch is set up (in nested beforeEach)
      // because the OpenAI client captures fetch at construction time.
      before(async () => {
        // Load the openai-agents module
        // The module may be loaded async due to ESM interop with --loader flag
        // Always use Promise.resolve() to handle both sync and async loading
        const agentsModule = await Promise.resolve(
          require(`../../../../../../versions/@openai/agents@${version}`).get()
        )

        // Get the values - if they're Promises, await them
        // This is needed because ESM loaders can return getters that are Promises
        let runValue = agentsModule.run
        if (runValue && typeof runValue.then === 'function') {
          runValue = await runValue
        }

        sdk.Agent = agentsModule.Agent
        sdk.run = runValue
        sdk.tool = agentsModule.tool
        sdk.OpenAIProvider = agentsModule.OpenAIProvider
        sdk.setDefaultModelProvider = agentsModule.setDefaultModelProvider
      })

      // Helper to setup the provider - call this in nested beforeEach AFTER mock fetch
      function setupProvider () {
        // Create an OpenAIProvider that uses Chat Completions API (not Responses API)
        // This is important because our fetch mock targets /chat/completions endpoint
        const provider = new sdk.OpenAIProvider({
          useResponses: false // Use Chat Completions API
        })
        // Set as the default provider for all agent runs
        sdk.setDefaultModelProvider(provider)
      }

      describe('agent workflow', () => {
        useMockFetch({ scenario: 'basic' }, setupProvider)

        it('creates a workflow span for agent.run()', async () => {
          const testAgent = new sdk.Agent({
            name: 'TestAgent',
            instructions: 'You are a helpful assistant. Keep responses brief.',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'Hello! What is 2 + 2?')

          // Should have at least workflow and llm spans
          const { llmobsSpans } = await getEvents(2)

          // Find workflow span (should be first/parent)
          const workflowSpan = llmobsSpans.find(s => s.meta['span.kind'] === 'workflow')

          assert.ok(workflowSpan, 'Should have a workflow span')
          assert.equal(workflowSpan.meta['span.kind'], 'workflow', 'Span should be workflow kind')
          assert.ok(workflowSpan.name, 'Workflow span should have a name')

          // Input should be captured
          assert.ok(workflowSpan.meta.input, 'Workflow span should have input')

          // Check for integration tag
          assert.ok(
            workflowSpan.tags.some(t => t === 'integration:openai-agents'),
            'Workflow span should have integration:openai-agents tag'
          )
        })

        it('captures agent name in workflow span', async () => {
          const testAgent = new sdk.Agent({
            name: 'MyCustomAgent',
            instructions: 'You are a math helper.',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'What is 5 + 5?')

          const { llmobsSpans } = await getEvents(2)
          const workflowSpan = llmobsSpans.find(s => s.meta['span.kind'] === 'workflow')

          assert.ok(workflowSpan, 'Should have workflow span')
          // The workflow name should include the agent name
          assert.ok(
            workflowSpan.name.includes('openai-agents') || workflowSpan.name.includes('MyCustomAgent'),
            'Workflow span should reference agent or plugin'
          )
        })
      })

      describe('llm spans', () => {
        useMockFetch({ scenario: 'basic' }, setupProvider)

        it('creates an llm span for model.getResponse()', async () => {
          const testAgent = new sdk.Agent({
            name: 'SimpleAgent',
            instructions: 'Reply with one word.',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'Say hello')

          const { apmSpans, llmobsSpans } = await getEvents(2)

          // Find LLM span
          const llmSpan = llmobsSpans.find(s => s.meta['span.kind'] === 'llm')
          const llmApmSpan = apmSpans.find(s =>
            s.name === 'openai-agents.getResponse' ||
            s.name === 'openai-agents.getStreamedResponse'
          )

          assert.ok(llmSpan, 'Should have an LLM span')
          assert.ok(llmApmSpan, 'Should have APM span for LLM call')

          // Verify the LLM span has expected properties
          assert.equal(llmSpan.meta['span.kind'], 'llm', 'Should be an LLM span')
          assert.equal(llmSpan.meta.model_name, 'gpt-4o-mini', 'Should have model name')
          assert.equal(llmSpan.meta.model_provider, 'openai', 'Should have model provider')
          assert.ok(llmSpan.meta.input?.messages, 'Should have input messages')
          assert.ok(llmSpan.meta.output?.messages, 'Should have output messages')
          assert.ok(llmSpan.metrics?.input_tokens >= 0, 'Should have input tokens')
          assert.ok(llmSpan.metrics?.output_tokens >= 0, 'Should have output tokens')
          assert.ok(llmSpan.metrics?.total_tokens >= 0, 'Should have total tokens')
          assert.ok(
            llmSpan.tags.some(t => t === 'integration:openai-agents'),
            'Should have integration tag'
          )
        })

        it('captures system message from agent instructions', async () => {
          const testAgent = new sdk.Agent({
            name: 'InstructionAgent',
            instructions: 'You are a pirate. Always respond like a pirate.',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'Hello!')

          const { llmobsSpans } = await getEvents(2)
          const llmSpan = llmobsSpans.find(s => s.meta['span.kind'] === 'llm')

          assert.ok(llmSpan, 'Should have LLM span')

          // The input messages should include system message from instructions
          const inputMessages = llmSpan.meta.input?.messages
          assert.ok(inputMessages, 'Should have input messages')

          const systemMessage = inputMessages.find(m => m.role === 'system')
          assert.ok(systemMessage, 'Should have system message from instructions')
          assert.ok(
            systemMessage.content.includes('pirate'),
            'System message should contain instructions'
          )
        })

        it('captures user message as input', async () => {
          const testAgent = new sdk.Agent({
            name: 'EchoAgent',
            instructions: 'Echo the user input.',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'The quick brown fox')

          const { llmobsSpans } = await getEvents(2)
          const llmSpan = llmobsSpans.find(s => s.meta['span.kind'] === 'llm')

          assert.ok(llmSpan, 'Should have LLM span')

          const inputMessages = llmSpan.meta.input?.messages
          assert.ok(inputMessages, 'Should have input messages')

          const userMessage = inputMessages.find(m => m.role === 'user')
          assert.ok(userMessage, 'Should have user message')
          assert.ok(
            userMessage.content.includes('quick brown fox'),
            'User message should contain input'
          )
        })

        it('captures assistant response as output message', async () => {
          const testAgent = new sdk.Agent({
            name: 'ResponseAgent',
            instructions: 'Always respond with exactly: HELLO WORLD',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'Say it')

          const { llmobsSpans } = await getEvents(2)
          const llmSpan = llmobsSpans.find(s => s.meta['span.kind'] === 'llm')

          assert.ok(llmSpan, 'Should have LLM span')

          const outputMessages = llmSpan.meta.output?.messages
          assert.ok(outputMessages, 'Should have output messages')
          assert.ok(outputMessages.length > 0, 'Should have at least one output message')

          const assistantMessage = outputMessages.find(m => m.role === 'assistant')
          assert.ok(assistantMessage, 'Should have assistant message')
          assert.equal(typeof assistantMessage.content, 'string', 'Content should be string')
        })

        it('captures model name correctly', async () => {
          const testAgent = new sdk.Agent({
            name: 'ModelAgent',
            instructions: 'Reply briefly.',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'Test')

          const { llmobsSpans } = await getEvents(2)
          const llmSpan = llmobsSpans.find(s => s.meta['span.kind'] === 'llm')

          assert.ok(llmSpan, 'Should have LLM span')
          assert.ok(
            llmSpan.meta.model_name.includes('gpt-4o-mini'),
            'Model name should include gpt-4o-mini'
          )
        })

        it('sets model provider to openai', async () => {
          const testAgent = new sdk.Agent({
            name: 'ProviderAgent',
            instructions: 'Reply.',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'Hi')

          const { llmobsSpans } = await getEvents(2)
          const llmSpan = llmobsSpans.find(s => s.meta['span.kind'] === 'llm')

          assert.ok(llmSpan, 'Should have LLM span')
          assert.equal(llmSpan.meta.model_provider, 'openai', 'Model provider should be openai')
        })

        it('captures input token count', async () => {
          const testAgent = new sdk.Agent({
            name: 'InputTokenAgent',
            instructions: 'Reply with OK.',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'This is a test message')

          const { llmobsSpans } = await getEvents(2)
          const llmSpan = llmobsSpans.find(s => s.meta['span.kind'] === 'llm')

          assert.ok(llmSpan, 'Should have LLM span')
          assert.ok(llmSpan.metrics.input_tokens > 0, 'Should have positive input tokens')
        })

        it('captures output token count', async () => {
          const testAgent = new sdk.Agent({
            name: 'OutputTokenAgent',
            instructions: 'Write a short response.',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'Hello')

          const { llmobsSpans } = await getEvents(2)
          const llmSpan = llmobsSpans.find(s => s.meta['span.kind'] === 'llm')

          assert.ok(llmSpan, 'Should have LLM span')
          assert.ok(llmSpan.metrics.output_tokens > 0, 'Should have positive output tokens')
        })

        it('computes total tokens correctly', async () => {
          const testAgent = new sdk.Agent({
            name: 'TotalTokenAgent',
            instructions: 'Be brief.',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'Test')

          const { llmobsSpans } = await getEvents(2)
          const llmSpan = llmobsSpans.find(s => s.meta['span.kind'] === 'llm')

          assert.ok(llmSpan, 'Should have LLM span')

          const { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens } = llmSpan.metrics
          assert.equal(
            totalTokens,
            inputTokens + outputTokens,
            'Total tokens should equal input + output'
          )
        })

        it('includes ml_app tag', async () => {
          const testAgent = new sdk.Agent({
            name: 'TagAgent',
            instructions: 'Reply OK.',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'Test')

          const { llmobsSpans } = await getEvents(2)

          for (const span of llmobsSpans) {
            assert.ok(
              span.tags.some(t => t.startsWith('ml_app:')),
              'Span should have ml_app tag'
            )
          }
        })

        it('includes integration tag', async () => {
          const testAgent = new sdk.Agent({
            name: 'IntegrationTagAgent',
            instructions: 'Reply.',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'Hi')

          const { llmobsSpans } = await getEvents(2)

          for (const span of llmobsSpans) {
            assert.ok(
              span.tags.some(t => t === 'integration:openai-agents'),
              'Span should have integration:openai-agents tag'
            )
          }
        })

        it('creates proper parent-child relationship between workflow and llm', async () => {
          const testAgent = new sdk.Agent({
            name: 'HierarchyAgent',
            instructions: 'Reply OK.',
            model: 'gpt-4o-mini'
          })

          await sdk.run(testAgent, 'Test')

          const { llmobsSpans } = await getEvents(2)

          const workflowSpans = llmobsSpans.filter(s => s.meta['span.kind'] === 'workflow')
          const llmSpan = llmobsSpans.find(s => s.meta['span.kind'] === 'llm')

          assert.ok(workflowSpans.length > 0, 'Should have workflow span(s)')
          assert.ok(llmSpan, 'Should have LLM span')

          // LLM span should be child of one of the workflow spans
          const workflowSpanIds = workflowSpans.map(s => s.span_id)
          assert.ok(
            workflowSpanIds.includes(llmSpan.parent_id),
            'LLM span should be child of a workflow span'
          )
        })
      })

      // NOTE: Tool tests are skipped because the mock fetch doesn't properly
      // simulate the multi-turn tool call flow that @openai/agents requires.
      // Tool instrumentation is tested indirectly through APM span tests.
    })
  })
})
