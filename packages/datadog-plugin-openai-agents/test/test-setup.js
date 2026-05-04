'use strict'

const path = require('node:path')

class OpenaiAgentsTestSetup {
  async setup (clientModule) {
    this.module = clientModule

    const agentsOpenaiDir = path.join(__dirname, '..', '..', '..', 'versions', '@openai', 'agents-openai@>=0.7.0')
    const { OpenAIResponsesModel } = require(agentsOpenaiDir).get()
    const openaiPath = require.resolve('openai', {
      paths: [path.join(__dirname, '..', '..', '..', 'versions', 'node_modules', '@openai', 'agents-openai')],
    })
    const { OpenAI } = require(openaiPath)

    const vcrClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY ?? 'test',
      baseURL: 'http://127.0.0.1:9126/vcr/openai',
    })

    clientModule.setDefaultModelProvider({
      createModel: (modelName) => new OpenAIResponsesModel(vcrClient, modelName),
    })

    const mockErrorClient = {
      baseURL: 'https://api.openai.com/v1',
      responses: {
        create: async () => {
          throw new Error('Intentional error for testing')
        },
      },
    }

    this.fakeModel = new OpenAIResponsesModel(vcrClient, 'gpt-4')
    this.streamModel = new OpenAIResponsesModel(vcrClient, 'gpt-4')
    this.errorModel = new OpenAIResponsesModel(mockErrorClient, 'gpt-4')

    this.agent = new clientModule.Agent({
      name: 'test_agent',
      instructions: 'You are a test agent',
      model: this.fakeModel,
    })

    this.errorAgent = new clientModule.Agent({
      name: 'error_agent',
      instructions: 'You are an error test agent',
      model: this.errorModel,
    })
  }

  async teardown () {
    this.module = undefined
    this.agent = undefined
    this.errorAgent = undefined
    this.fakeModel = undefined
    this.streamModel = undefined
    this.errorModel = undefined
  }

  async run () {
    return this.module.run(this.agent, 'hello', { maxTurns: 2 })
  }

  async runError () {
    return this.module.run(this.errorAgent, 'hello', { maxTurns: 1 })
  }

  /**
   * Compose agents-core's span helpers directly to produce the hierarchy:
   *   trace("handoff-test") → agent(agent_a) → handoff(agent_a→agent_b) → agent(agent_b)
   * Bypasses the model call to avoid needing cassette support for handoff
   * tool-call responses.
   */
  async multiAgentHandoff () {
    return this.module.withTrace('handoff-test', async () => {
      return this.module.withAgentSpan(async () => {
        return this.module.withHandoffSpan(async () => {
          return this.module.withAgentSpan(async () => {}, { data: { name: 'agent_b' } })
        }, { data: { from_agent: 'agent_a', to_agent: 'agent_b' } })
      }, { data: { name: 'agent_a' } })
    })
  }

  async getResponse () {
    return this.module.withTrace('test-getResponse', async () => {
      return this.fakeModel.getResponse({
        systemInstructions: 'test',
        input: 'hello',
        modelSettings: {},
        tools: [],
        outputSchema: undefined,
        handoffs: [],
        previousResponseId: undefined,
      })
    })
  }

  async getStreamedResponse () {
    return this.module.withTrace('test-getStreamedResponse', async () => {
      // agents-openai only creates a response Span when request.tracing is truthy
      const iter = await this.streamModel.getStreamedResponse({
        systemInstructions: 'test',
        input: 'hello',
        modelSettings: {},
        tools: [],
        outputSchema: undefined,
        handoffs: [],
        previousResponseId: undefined,
        tracing: true,
      })
      // eslint-disable-next-line no-unused-vars
      for await (const _item of iter) {
        // consume stream
      }
    })
  }
}

module.exports = OpenaiAgentsTestSetup
