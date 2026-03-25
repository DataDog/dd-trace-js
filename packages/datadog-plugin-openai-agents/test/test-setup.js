'use strict'

const path = require('path')

class OpenaiAgentsTestSetup {
  async setup (module) {
    this.module = module

    const agentsOpenaiVersionDir = path.join(
      __dirname, '..', '..', '..', 'versions', '@openai', 'agents-openai@>=0.7.0'
    )
    const { OpenAIResponsesModel } = require(agentsOpenaiVersionDir).get()
    const openaiPath = require.resolve('openai', {
      paths: [path.join(__dirname, '..', '..', '..', 'versions', 'node_modules', '@openai', 'agents-openai')],
    })
    const { OpenAI } = require(openaiPath)

    const vcrClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY ?? 'test',
      baseURL: 'http://127.0.0.1:9126/vcr/openai',
    })

    module.setDefaultModelProvider({
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

    this.agent = new module.Agent({
      name: 'test_agent',
      instructions: 'You are a test agent',
      model: this.fakeModel,
    })

    this.errorAgent = new module.Agent({
      name: 'error_agent',
      instructions: 'You are an error test agent',
      model: this.errorModel,
    })

    this.targetAgent = new module.Agent({
      name: 'target_agent',
      instructions: 'You are a target agent',
      model: this.fakeModel,
    })

    this.testTool = module.tool({
      name: 'test_tool',
      description: 'A test tool',
      parameters: {},
      execute: async (ctx, args) => {
        return 'tool result'
      },
    })

    this.errorTool = module.tool({
      name: 'error_tool',
      description: 'A tool that errors',
      parameters: {},
      execute: async (ctx, args) => {
        throw new Error('Intentional error for testing')
      },
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

  async getResponse () {
    // Must wrap in withTrace() because OpenAIResponsesModel.getResponse uses the
    // library's internal tracing (withResponseSpan) which requires an active trace context
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

  async getResponseError () {
    return this.module.withTrace('test-getResponseError', async () => {
      return this.errorModel.getResponse({
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
      // After orchestrion wrapping, async *getStreamedResponse returns a Promise<AsyncIterator>
      // instead of an AsyncIterator directly, so we must await it first
      const iter = await this.streamModel.getStreamedResponse({
        systemInstructions: 'test',
        input: 'hello',
        modelSettings: {},
        tools: [],
        outputSchema: undefined,
        handoffs: [],
        previousResponseId: undefined,
      })
      // eslint-disable-next-line no-unused-vars
      for await (const _item of iter) {
        // consume stream
      }
    })
  }

  async getStreamedResponseError () {
    return this.module.withTrace('test-getStreamedResponseError', async () => {
      // After orchestrion wrapping, async *getStreamedResponse returns a Promise<AsyncIterator>
      const iter = await this.errorModel.getStreamedResponse({
        systemInstructions: 'test',
        input: 'hello',
        modelSettings: {},
        tools: [],
        outputSchema: undefined,
        handoffs: [],
        previousResponseId: undefined,
      })
      // eslint-disable-next-line no-unused-vars
      for await (const _item of iter) {
        // consume stream
      }
    })
  }

  async invokeFunctionTool () {
    return this.module.invokeFunctionTool({
      tool: this.testTool,
      runContext: new this.module.RunContext({ context: {} }),
      input: '{}',
      details: { toolCallId: 'test-call-id' },
    })
  }

  async invokeFunctionToolError () {
    return this.module.invokeFunctionTool({
      tool: this.errorTool,
      runContext: new this.module.RunContext({ context: {} }),
      input: '{}',
      details: { toolCallId: 'error-call-id' },
    })
  }

  async onInvokeHandoff () {
    // Use the handoff() factory function (not new Handoff() directly) because
    // the orchestrion instruments the onInvokeHandoff function INSIDE the factory
    const h = this.module.handoff(this.targetAgent)
    return h.onInvokeHandoff(
      new this.module.RunContext({ context: {} }),
      '{}'
    )
  }

  async onInvokeHandoffError () {
    // Create a handoff with inputType so parser is set, then pass empty input
    // to trigger ModelBehaviorError('Handoff function expected non empty input')
    const h = this.module.handoff(this.targetAgent, {
      inputType: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
        additionalProperties: false,
      },
      onHandoff: async (ctx, parsed) => {
        // This won't be reached since empty input triggers error first
      },
    })
    return h.onInvokeHandoff(
      new this.module.RunContext({ context: {} }),
      '' // Empty input triggers ModelBehaviorError
    )
  }

  async runInputGuardrails () {
    const guardrail = {
      type: 'tool_input',
      name: 'test_input_guardrail',
      run: async ({ context, agent, toolCall }) => {
        return { allow: true }
      },
    }
    return this.module.runToolInputGuardrails({
      guardrails: [guardrail],
      context: new this.module.RunContext({ context: {} }),
      agent: this.agent,
      toolCall: { id: 'test-call', name: 'test_tool', arguments: '{}' },
    })
  }

  async runInputGuardrailsError () {
    const guardrail = {
      type: 'tool_input',
      name: 'error_input_guardrail',
      run: async ({ context, agent, toolCall }) => {
        throw new Error('Intentional error for testing')
      },
    }
    return this.module.runToolInputGuardrails({
      guardrails: [guardrail],
      context: new this.module.RunContext({ context: {} }),
      agent: this.agent,
      toolCall: { id: 'test-call', name: 'test_tool', arguments: '{}' },
    })
  }

  async runOutputGuardrails () {
    const guardrail = {
      type: 'tool_output',
      name: 'test_output_guardrail',
      run: async ({ context, agent, toolCall, toolOutput }) => {
        return { allow: true }
      },
    }
    return this.module.runToolOutputGuardrails({
      guardrails: [guardrail],
      context: new this.module.RunContext({ context: {} }),
      agent: this.agent,
      toolCall: { id: 'test-call', name: 'test_tool', arguments: '{}' },
      toolOutput: 'test output',
    })
  }

  async runOutputGuardrailsError () {
    const guardrail = {
      type: 'tool_output',
      name: 'error_output_guardrail',
      run: async ({ context, agent, toolCall, toolOutput }) => {
        throw new Error('Intentional error for testing')
      },
    }
    return this.module.runToolOutputGuardrails({
      guardrails: [guardrail],
      context: new this.module.RunContext({ context: {} }),
      agent: this.agent,
      toolCall: { id: 'test-call', name: 'test_tool', arguments: '{}' },
      toolOutput: 'test output',
    })
  }
}

module.exports = OpenaiAgentsTestSetup
