'use strict'

const path = require('node:path')

const { finish, loadTracer, loadVersionedModule } = require('../common')

let agents
let openai

function setup (chatApi = false) {
  const tracer = loadTracer('openai-agents')
  agents = loadVersionedModule('@openai/agents')
  openai = require(path.join(
    path.resolve(__dirname, '../../../../../../../'),
    'versions/@openai/agents@0.7.0'
  )).get('openai')
  if (chatApi) agents.setOpenAIAPI('chat_completions')
  agents.setDefaultOpenAIClient(new openai.OpenAI({
    apiKey: 'x',
    baseURL: `${process.env.PROVIDER_BASE_URL}/v1`,
  }))
  return { agents, tracer, finish: () => finish(tracer) }
}

let add
let addWithError
let research

function setupTools () {
  add = agents.tool({
    name: 'add',
    description: 'Add two numbers together',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'integer' },
        b: { type: 'integer' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    execute: async ({ a, b }) => a + b,
  })

  addWithError = agents.tool({
    name: 'add',
    description: 'Add two numbers together',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'integer' },
        b: { type: 'integer' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    execute: async () => {
      throw new Error('This is a test error')
    },
  })

  research = agents.tool({
    name: 'research',
    description: 'Research the internet on a topic.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async () =>
      'united beat liverpool 2-1 yesterday. also a lot of other stuff happened. like super important stuff. ' +
      'blah blah blah.',
  })
}

function simpleAgent () {
  setupTools()
  return new agents.Agent({
    name: 'Simple Agent',
    instructions: 'You are a helpful assistant who answers questions concisely and accurately.',
    model: 'gpt-4o',
  })
}

function additionAgent () {
  setupTools()
  return new agents.Agent({
    name: 'Addition Agent',
    instructions: 'You are a helpful assistant specialized in addition calculations.',
    tools: [add],
    model: 'gpt-4o',
  })
}

function additionAgentWithToolErrors () {
  setupTools()
  return new agents.Agent({
    name: 'Addition Agent',
    instructions:
      'You are a helpful assistant specialized in addition calculations. Do not retry the tool call if it errors ' +
      'and instead return immediately',
    tools: [addWithError],
    model: 'gpt-4o',
  })
}

function researchWorkflow () {
  setupTools()
  const summarizer = new agents.Agent({
    name: 'Summarizer',
    instructions: 'You are a helpful assistant that can summarize a research results.',
    model: 'gpt-4o',
  })
  return new agents.Agent({
    name: 'Researcher',
    instructions:
      'You are a helpful assistant that can research a topic using your research tool. Always research the topic ' +
      'before summarizing.',
    tools: [research],
    handoffs: [agents.handoff(summarizer, { toolNameOverride: 'transfer_to_summarizer' })],
    model: 'gpt-4o',
  })
}

function guardrailAgent () {
  setupTools()
  const guardrail = {
    name: 'simple_input_guardrail',
    execute: async () => ({ outputInfo: 'dummy', tripwireTriggered: false }),
  }
  const outputGuardrail = {
    name: 'simple_output_guardrail',
    execute: async () => ({ outputInfo: 'dummy', tripwireTriggered: false }),
  }
  return new agents.Agent({
    name: 'Simple Agent with Guardrails',
    instructions: 'You are a helpful assistant specialized in addition calculations.',
    inputGuardrails: [guardrail],
    outputGuardrails: [outputGuardrail],
    tools: [add],
    model: 'gpt-4o',
  })
}

module.exports = {
  additionAgent,
  additionAgentWithToolErrors,
  finish,
  guardrailAgent,
  researchWorkflow,
  setup,
  simpleAgent,
}
