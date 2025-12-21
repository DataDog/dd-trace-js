'use strict'

class OpenaiAgentsTestSetup {
  async setup (module) {
    // Set up OpenAI API key (using a mock or env var)
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = 'sk-mock-key-for-testing'
    }

    // Extract classes from the loaded module
    // @openai/agents-core exports: Agent, Runner, tool (function), etc.
    // Note: FunctionTool is a TYPE, not a constructor - use tool() function to create tools
    const { Agent, Runner, tool } = module

    // Store references for later use
    this.Agent = Agent
    this.Runner = Runner
    this.toolFn = tool

    // Create a function tool for testing using the tool() factory function
    this.weatherTool = tool({
      name: 'get_weather',
      description: 'Get the current weather for a city',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'The city name' }
        },
        required: ['city']
      },
      strict: false,
      execute: async (input) => {
        // input is a string when using JSON schema parameters
        const parsed = typeof input === 'string' ? JSON.parse(input) : input
        return `The weather in ${parsed.city} is sunny and 72°F`
      }
    })

    // Create a mock Model that implements the Model interface
    this.mockModel = {
      getResponse: async (request) => {
        return {
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            requests: 1
          },
          output: [{
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'This is a mock response' }]
          }],
          responseId: 'mock-response-1'
        }
      },
      async *getStreamedResponse (request) {
        yield {
          type: 'response.completed',
          response: {
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, requests: 1 },
            output: [{
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'This is a mock response' }]
            }]
          }
        }
      }
    }

    // Create a mock ModelProvider
    this.mockModelProvider = {
      getModel: (modelName) => this.mockModel
    }

    // Set default model provider so Runner can be created
    const { setDefaultModelProvider } = module
    setDefaultModelProvider(this.mockModelProvider)

    // Create agent using string model name (will be resolved by provider)
    this.agent = new Agent({
      name: 'TestAgent',
      instructions: 'You are a helpful assistant',
      model: 'mock-model',
      tools: [this.weatherTool]
    })

    // Create runner (now works because default model provider is set)
    this.runner = new Runner()
  }

  async teardown () {
  }

  async runnerRun () {
    const result = await this.runner.run(this.agent, 'Hello', { maxTurns: 1 })
    return result
  }

  async runnerRunError () {
    await this.runner.run(null, 'test')
  }

  async functiontoolInvoke () {
    // Create a fresh tool to ensure it picks up the wrapped tool() function
    // (in case instrumentation was set up after the initial tool was created)
    const { tool } = require('../../../versions/@openai/agents-core@>=0.3.7').get()
    const freshTool = tool({
      name: 'fresh_weather',
      description: 'Get weather',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city']
      },
      strict: false,
      execute: async (input) => {
        const parsed = typeof input === 'string' ? JSON.parse(input) : input
        return `Weather in ${parsed.city}: sunny`
      }
    })

    const mockRunContext = { span: null }
    const result = await freshTool.invoke(
      mockRunContext,
      '{"city":"New York"}',
      {
        toolCall: {
          id: 'test-1',
          name: 'fresh_weather',
          arguments: '{"city":"New York"}'
        }
      }
    )
    return result
  }

  async functiontoolInvokeError () {
    // Create a fresh tool for error test
    const { tool } = require('../../../versions/@openai/agents-core@>=0.3.7').get()
    const freshTool = tool({
      name: 'error_weather',
      description: 'Get weather',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city']
      },
      strict: false,
      // Disable the default error handler so errors propagate to our wrapper
      errorFunction: null,
      execute: async () => {
        throw new Error('Tool execution error')
      }
    })

    const mockRunContext = { span: null }
    await freshTool.invoke(mockRunContext, '{"city":"New York"}', {
      toolCall: { id: 'test-2', name: 'error_weather', arguments: '{"city":"New York"}' }
    })
  }

  async openaichatcompletionsmodelGetresponse () {
    // Create a mock OpenAI client
    const mockOpenAIClient = {
      baseURL: 'https://api.openai.com/v1',
      chat: {
        completions: {
          create: async (request) => {
            return {
              id: 'mock-completion-id',
              object: 'chat.completion',
              created: Date.now(),
              model: 'gpt-4',
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'This is a mock response'
                },
                finish_reason: 'stop'
              }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15
              }
            }
          }
        }
      },
      // Attach model to the client for the wrapper to access
      _model: 'gpt-4'
    }

    // Import the real OpenAIChatCompletionsModel class and tracing helpers from versions folder
    const { OpenAIChatCompletionsModel } = require('../../../versions/@openai/agents-openai@>=0.3.7').get()
    const { withTrace, Trace } = require('../../../versions/@openai/agents-core@>=0.3.7').get()

    const realModel = new OpenAIChatCompletionsModel(mockOpenAIClient, 'gpt-4')

    // The library's getResponse uses withGenerationSpan which requires a trace context
    // We need to wrap the call in withTrace to provide that context
    const trace = new Trace({ name: 'test-trace', traceId: 'test-trace-id' })
    const response = await withTrace(trace, async () => {
      return realModel.getResponse({
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
        modelSettings: {},
        outputType: 'text'
      })
    })
    return response
  }

  async openaichatcompletionsmodelGetresponseError () {
    // Create a mock OpenAI client that throws an error
    const mockOpenAIClientError = {
      baseURL: 'https://api.openai.com/v1',
      chat: {
        completions: {
          create: async () => {
            throw new Error('Mock API error')
          }
        }
      }
    }

    // Import and use the real OpenAIChatCompletionsModel class from versions folder
    const { OpenAIChatCompletionsModel } = require('../../../versions/@openai/agents-openai@>=0.3.7').get()
    const { withTrace, Trace } = require('../../../versions/@openai/agents-core@>=0.3.7').get()
    const realModel = new OpenAIChatCompletionsModel(mockOpenAIClientError, 'gpt-4')

    // Wrap in withTrace for consistency with happy path
    const trace = new Trace({ name: 'test-trace', traceId: 'test-trace-id' })
    await withTrace(trace, async () => {
      return realModel.getResponse({
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
        modelSettings: {},
        outputType: 'text'
      })
    })
  }
}

module.exports = OpenaiAgentsTestSetup
