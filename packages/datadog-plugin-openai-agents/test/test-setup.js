'use strict'

const path = require('node:path')

function createStreamResponse (status) {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 0,
    status,
    output: status === 'completed'
      ? [{
          id: 'msg_test',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello', annotations: [] }],
        }]
      : [],
    usage: status === 'completed'
      ? {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        }
      : null,
    model: 'gpt-4-0613',
    parallel_tool_calls: true,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    metadata: {},
  }
}

function createStreamEvent (event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function createStreamingFetch () {
  return async () => {
    const responseStarted = createStreamResponse('in_progress')
    const responseCompleted = createStreamResponse('completed')
    const body = [
      createStreamEvent('response.created', {
        type: 'response.created',
        response: responseStarted,
        sequence_number: 0,
      }),
      createStreamEvent('response.output_text.delta', {
        type: 'response.output_text.delta',
        content_index: 0,
        delta: 'hello',
        item_id: 'msg_test',
        output_index: 0,
        sequence_number: 1,
      }),
      createStreamEvent('response.completed', {
        type: 'response.completed',
        response: responseCompleted,
        sequence_number: 2,
      }),
      'data: [DONE]\n\n',
    ].join('')

    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-request-id': 'req_test',
      },
    })
  }
}

function createResponseFetch () {
  return async () => {
    return new Response(JSON.stringify(createStreamResponse('completed')), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req_test',
      },
    })
  }
}

function createHandoffFetch () {
  let request = 0

  return async () => {
    const response = createStreamResponse('completed')
    response.output = request++ === 0
      ? [{
          id: 'fc_handoff',
          type: 'function_call',
          call_id: 'call_handoff',
          name: 'transfer_to_agent_b',
          arguments: '{}',
          status: 'completed',
        }]
      : [{
          id: 'msg_final',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done', annotations: [] }],
        }]

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': `req_handoff_${request}`,
      },
    })
  }
}

class OpenaiAgentsTestSetup {
  async setup (clientModule, version) {
    this.module = clientModule

    const agentsOpenaiDir = path.join(__dirname, '..', '..', '..', 'versions', '@openai', `agents-openai@${version}`)
    const { OpenAIResponsesModel } = require(agentsOpenaiDir).get()
    const openaiPath = require.resolve('openai', {
      paths: [path.join(__dirname, '..', '..', '..', 'versions', 'node_modules', '@openai', 'agents-openai')],
    })
    const { OpenAI } = require(openaiPath)

    const mockClient = new OpenAI({
      apiKey: 'test',
      baseURL: 'https://api.openai.com/v1',
      fetch: createResponseFetch(),
    })

    clientModule.setDefaultModelProvider({
      createModel: (modelName) => new OpenAIResponsesModel(mockClient, modelName),
    })

    const mockErrorClient = {
      baseURL: 'https://api.openai.com/v1',
      responses: {
        create: async () => {
          throw new Error('Intentional error for testing')
        },
      },
    }

    const fakeModel = new OpenAIResponsesModel(mockClient, 'gpt-4')
    const streamModel = new OpenAIResponsesModel(new OpenAI({
      apiKey: 'test',
      baseURL: 'https://api.openai.com/v1',
      fetch: createStreamingFetch(),
    }), 'gpt-4')
    const errorModel = new OpenAIResponsesModel(mockErrorClient, 'gpt-4')
    const handoffModel = new OpenAIResponsesModel(new OpenAI({
      apiKey: 'test',
      baseURL: 'https://api.openai.com/v1',
      fetch: createHandoffFetch(),
    }), 'gpt-4')

    this.agent = new clientModule.Agent({
      name: 'test_agent',
      instructions: 'You are a test agent',
      model: fakeModel,
    })

    this.streamAgent = new clientModule.Agent({
      name: 'test_agent',
      instructions: 'You are a test agent',
      model: streamModel,
    })

    this.errorAgent = new clientModule.Agent({
      name: 'error_agent',
      instructions: 'You are an error test agent',
      model: errorModel,
    })

    this.handoffAgentB = new clientModule.Agent({
      name: 'agent_b',
      instructions: 'Finish the request',
      model: handoffModel,
    })
    this.handoffAgentA = new clientModule.Agent({
      name: 'agent_a',
      instructions: 'Hand the request to agent_b',
      model: handoffModel,
      handoffs: [this.handoffAgentB],
    })
  }

  async teardown () {
    this.module = undefined
    this.agent = undefined
    this.streamAgent = undefined
    this.errorAgent = undefined
    this.handoffAgentA = undefined
    this.handoffAgentB = undefined
  }

  async run () {
    return this.module.run(this.agent, 'hello', { maxTurns: 2 })
  }

  async runStreamed () {
    const result = await this.module.run(this.streamAgent, 'hello', { maxTurns: 2, stream: true })
    for await (const event of result) {
      // Drain the stream so the SDK finishes the underlying response span.
      if (event === undefined) continue
    }
    await result.completed
    return result
  }

  async runError () {
    return this.module.run(this.errorAgent, 'hello', { maxTurns: 1 })
  }

  async multiAgentHandoff () {
    return this.module.run(this.handoffAgentA, 'start', { maxTurns: 2 })
  }
}

module.exports = OpenaiAgentsTestSetup
