'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { withVersions } = require('../../../setup/mocha')

const {
  assertLlmObsSpanEvent,
  MOCK_NOT_NULLISH,
  MOCK_STRING,
  useLlmObs,
} = require('../../util')

const AGENT_INSTRUCTIONS = 'You are a test agent'

function createResponse (output, model = 'gpt-4-0613') {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 0,
    status: 'completed',
    instructions: AGENT_INSTRUCTIONS,
    output,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    model,
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

function createMessageOutput (text) {
  return {
    id: 'msg_test',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
}

function createFetch (responses) {
  let index = 0

  return async () => {
    const response = responses[Math.min(index++, responses.length - 1)]
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req_test',
      },
    })
  }
}

function createStreamFetch (text, model = 'gpt-4o') {
  return async () => {
    const response = {
      id: 'resp_stream_test',
      object: 'response',
      status: 'completed',
      output: [createMessageOutput(text)],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      model,
    }
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_text.delta', delta: text },
      { type: 'response.completed', response },
    ]
    const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'x-request-id': 'req_stream_test',
      },
    })
  }
}

describe('integrations', () => {
  describe('openai-agents LLMObs', () => {
    const { getEvents } = useLlmObs({ plugin: ['openai-agents', 'openai'] })

    let agentsCore
    let agent
    let chatCompletionsAgent
    let handoffAgent
    let toolAgent
    let streamedAgent
    let toolErrorAgent

    withVersions('openai-agents', '@openai/agents', (version) => {
      before(() => {
        agentsCore = require(`../../../../../../versions/@openai/agents@${version}`).get()

        const { OpenAIChatCompletionsModel, OpenAIResponsesModel } =
          require(`../../../../../../versions/@openai/agents-openai@${version}`).get()

        const agentsOpenaiDir = path.join(
          __dirname, '..', '..', '..', '..', '..', '..', 'versions', 'node_modules', '@openai', 'agents-openai'
        )
        const openaiPath = require.resolve('openai', { paths: [agentsOpenaiDir] })
        const { OpenAI } = require(openaiPath)

        const mockClient = new OpenAI({
          apiKey: 'test',
          baseURL: 'https://api.openai.com/v1',
          fetch: createFetch([createResponse([createMessageOutput('hello')])]),
        })
        const chatCompletionsClient = new OpenAI({
          apiKey: 'test',
          baseURL: 'https://resource.openai.azure.com/openai/deployments/test',
          fetch: createFetch([{
            id: 'chatcmpl_test',
            object: 'chat.completion',
            created: 0,
            model: 'gpt-4o',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'hello' },
              finish_reason: 'stop',
            }],
            usage: {
              prompt_tokens: 2,
              completion_tokens: 1,
              total_tokens: 3,
            },
          }]),
        })
        const toolErrorClient = new OpenAI({
          apiKey: 'test',
          baseURL: 'https://api.openai.com/v1',
          fetch: createFetch([
            createResponse([{
              id: 'fc_test',
              type: 'function_call',
              call_id: 'call_test',
              name: 'add',
              arguments: '{"a":1,"b":2}',
              status: 'completed',
            }], 'gpt-4o-mini'),
            createResponse([createMessageOutput('done')], 'gpt-4o-mini'),
          ]),
        })
        const handoffClient = new OpenAI({
          apiKey: 'test',
          baseURL: 'https://api.openai.com/v1',
          fetch: createFetch([
            createResponse([{
              id: 'fc_handoff',
              type: 'function_call',
              call_id: 'call_handoff',
              name: 'transfer_to_agent_b',
              arguments: '{}',
              status: 'completed',
            }], 'gpt-4o-mini'),
            createResponse([createMessageOutput('done')], 'gpt-4o-mini'),
          ]),
        })
        const toolClient = new OpenAI({
          apiKey: 'test',
          baseURL: 'https://api.openai.com/v1',
          fetch: createFetch([
            createResponse([{
              id: 'fc_tool',
              type: 'function_call',
              call_id: 'call_tool',
              name: 'add',
              arguments: '{"a":1,"b":2}',
              status: 'completed',
            }], 'gpt-4o-mini'),
            createResponse([createMessageOutput('3')], 'gpt-4o-mini'),
          ]),
        })
        const streamClient = new OpenAI({
          apiKey: 'test',
          baseURL: 'https://api.openai.com/v1',
          fetch: createStreamFetch('The capital of France is Paris.'),
        })

        agentsCore.setDefaultModelProvider({
          createModel: (modelName) => new OpenAIResponsesModel(mockClient, modelName),
        })

        agent = new agentsCore.Agent({
          name: 'test_agent',
          instructions: AGENT_INSTRUCTIONS,
          model: new OpenAIResponsesModel(mockClient, 'gpt-4'),
        })
        chatCompletionsAgent = new agentsCore.Agent({
          name: 'chat_completions_agent',
          instructions: AGENT_INSTRUCTIONS,
          model: new OpenAIChatCompletionsModel(chatCompletionsClient, 'gpt-4o'),
        })

        const handoffModel = new OpenAIResponsesModel(handoffClient, 'gpt-4o-mini')
        const handoffAgentB = new agentsCore.Agent({
          name: 'agent_b',
          instructions: 'Finish the request',
          model: handoffModel,
        })
        handoffAgent = new agentsCore.Agent({
          name: 'agent_a',
          instructions: 'Hand the request to agent_b',
          model: handoffModel,
          handoffs: [handoffAgentB],
        })
        const additionTool = agentsCore.tool({
          name: 'add',
          description: 'Adds two numbers.',
          parameters: {
            type: 'object',
            properties: {
              a: { type: 'number' },
              b: { type: 'number' },
            },
            required: ['a', 'b'],
          },
          execute: async ({ a, b }) => a + b,
        })
        toolAgent = new agentsCore.Agent({
          name: 'tool_agent',
          instructions: 'Use the add tool.',
          model: new OpenAIResponsesModel(toolClient, 'gpt-4o-mini'),
          tools: [additionTool],
        })
        streamedAgent = new agentsCore.Agent({
          name: 'streamed_agent',
          instructions: AGENT_INSTRUCTIONS,
          model: new OpenAIResponsesModel(streamClient, 'gpt-4o'),
        })

        // Tool with a real parameter schema so the model has something to
        // pass — the underlying `execute` always throws, exercising the
        // tool-error path. Mirrors dd-trace-py's
        // `addition_agent_with_tool_errors` setup.
        const additionErrorTool = agentsCore.tool({
          name: 'add',
          description: 'Adds two numbers and returns the result.',
          parameters: {
            type: 'object',
            properties: {
              a: { type: 'number', description: 'First number' },
              b: { type: 'number', description: 'Second number' },
            },
            required: ['a', 'b'],
            additionalProperties: false,
          },
          execute: async () => {
            throw new Error('Intentional error for testing')
          },
        })

        toolErrorAgent = new agentsCore.Agent({
          name: 'addition_agent_with_tool_errors',
          instructions: 'You are a calculator. Use the `add` tool to answer math questions.',
          model: new OpenAIResponsesModel(toolErrorClient, 'gpt-4o-mini'),
          tools: [additionErrorTool],
        })
      })

      // Response metadata mirrors Python's openai-agents integration:
      // response-echoed configuration fields with no filtering of OpenAI
      // defaults — see `OaiSpanAdapter.llmobs_metadata` in dd-trace-py.
      const COMMON_RESPONSE_METADATA = {
        temperature: MOCK_NOT_NULLISH,
        top_p: MOCK_NOT_NULLISH,
        tool_choice: MOCK_NOT_NULLISH,
        tools: MOCK_NOT_NULLISH,
        truncation: MOCK_NOT_NULLISH,
        text: MOCK_NOT_NULLISH,
      }

      describe('run', () => {
        it('submits a workflow span for a basic run call', async () => {
          // run() produces three LLMObs spans (workflow, agent, llm) — see
          // dd-trace-py's `test_llmobs_single_agent`. We only assert the
          // workflow span here; the LLM span shape is covered separately.
          await agentsCore.run(agent, 'hello', { maxTurns: 1 })

          const { apmSpans, llmobsSpans } = await getEvents(3)
          const workflowEvent = llmobsSpans.find(s => s.meta?.['span.kind'] === 'workflow')
          const agentEvent = llmobsSpans.find(s => s.name === 'test_agent')
          const workflowApmSpan = apmSpans.find(s => s.name === 'Agent workflow')

          assertLlmObsSpanEvent(workflowEvent, {
            span: workflowApmSpan,
            spanKind: 'workflow',
            name: 'Agent workflow',
            inputValue: 'hello',
            outputValue: MOCK_STRING,
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
          assertLlmObsSpanEvent(agentEvent, {
            span: apmSpans.find(s => s.name === 'test_agent'),
            parentId: workflowApmSpan.span_id,
            spanKind: 'agent',
            name: 'test_agent',
            metadata: {
              _dd: {
                agent_manifest: {
                  framework: 'OpenAI',
                  name: 'test_agent',
                  instructions: AGENT_INSTRUCTIONS,
                  handoff_description: '',
                },
              },
              output_type: 'text',
            },
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })

        it('submits an llm span under the agent span with the response shape', async () => {
          // Under `Runner.run`, the response oai-span is a direct child of
          // the top-level agent span, so the LLMObs span name becomes
          // `${agent_name} (LLM)` (Python parity).
          await agentsCore.run(agent, 'hello', { maxTurns: 1 })

          const { apmSpans, llmobsSpans } = await getEvents(3)
          const llmEvent = llmobsSpans.find(s => s.name === 'test_agent (LLM)')
          const llmApmSpan = apmSpans.find(s => s.name === 'openai_agents.response')
          const agentApmSpan = apmSpans.find(s => s.name === 'test_agent')

          assertLlmObsSpanEvent(llmEvent, {
            span: llmApmSpan,
            parentId: agentApmSpan?.span_id,
            spanKind: 'llm',
            name: 'test_agent (LLM)',
            modelName: 'gpt-4-0613',
            modelProvider: 'openai',
            inputMessages: [
              { role: 'system', content: AGENT_INSTRUCTIONS },
              { role: 'user', content: 'hello' },
            ],
            outputMessages: [
              { role: 'assistant', content: MOCK_STRING },
            ],
            metrics: {
              input_tokens: MOCK_NOT_NULLISH,
              output_tokens: MOCK_NOT_NULLISH,
              total_tokens: MOCK_NOT_NULLISH,
            },
            metadata: COMMON_RESPONSE_METADATA,
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })

        it('uses the Chat Completions client URL to identify the model provider', async () => {
          await agentsCore.run(chatCompletionsAgent, 'hello', { maxTurns: 1 })

          const { llmobsSpans } = await getEvents(3)
          const llmEvent = llmobsSpans.find(s => s.meta?.['span.kind'] === 'llm')

          assert.strictEqual(llmEvent.meta.model_provider, 'azure_openai')
          assert.deepStrictEqual(llmEvent.meta.output.messages, [{
            role: 'assistant',
            content: 'hello',
          }])
        })

        it('keeps the workflow open through a real multi-agent handoff', async () => {
          const result = await agentsCore.run(handoffAgent, 'start', { maxTurns: 2 })
          assert.strictEqual(result.finalOutput, 'done')

          const { apmSpans, llmobsSpans } = await getEvents(6)
          const workflowApmSpan = apmSpans.find(s => s.name === 'Agent workflow')
          const agentAApmSpan = apmSpans.find(s => s.name === 'agent_a')
          const agentBApmSpan = apmSpans.find(s => s.name === 'agent_b')
          const handoffApmSpan = apmSpans.find(s => s.name === 'transfer_to_agent_b')
          const workflowEvent = llmobsSpans.find(s => s.meta?.['span.kind'] === 'workflow')
          const handoffEvent = llmobsSpans.find(s => s.name === 'transfer_to_agent_b')

          assert.ok(workflowApmSpan, 'expected a workflow APM span')
          assert.ok(agentAApmSpan, 'expected agent_a APM span')
          assert.ok(agentBApmSpan, 'expected agent_b APM span')
          assert.ok(handoffApmSpan, 'expected a handoff APM span')
          assert.strictEqual(agentAApmSpan.parent_id.toString(), workflowApmSpan.span_id.toString())
          assert.strictEqual(agentBApmSpan.parent_id.toString(), workflowApmSpan.span_id.toString())
          assert.strictEqual(handoffApmSpan.parent_id.toString(), agentAApmSpan.span_id.toString())

          assertLlmObsSpanEvent(workflowEvent, {
            span: workflowApmSpan,
            spanKind: 'workflow',
            name: 'Agent workflow',
            inputValue: 'start',
            outputValue: MOCK_STRING,
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
          assertLlmObsSpanEvent(handoffEvent, {
            span: handoffApmSpan,
            parentId: agentAApmSpan.span_id,
            spanKind: 'tool',
            name: 'transfer_to_agent_b',
            inputValue: 'agent_a',
            outputValue: 'agent_b',
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
          assertLlmObsSpanEvent(
            llmobsSpans.find(s => s.name === 'agent_a'),
            {
              span: agentAApmSpan,
              parentId: workflowApmSpan.span_id,
              spanKind: 'agent',
              name: 'agent_a',
              metadata: {
                _dd: {
                  agent_manifest: {
                    framework: 'OpenAI',
                    name: 'agent_a',
                    instructions: 'Hand the request to agent_b',
                    handoff_description: '',
                    handoffs: [{
                      agent_name: 'agent_b',
                      handoff_description: '',
                    }],
                  },
                },
                handoffs: ['agent_b'],
                output_type: 'text',
              },
              tags: { ml_app: 'test', integration: 'openai-agents' },
            }
          )
          assertLlmObsSpanEvent(
            llmobsSpans.find(s => s.name === 'agent_b'),
            {
              span: agentBApmSpan,
              parentId: workflowApmSpan.span_id,
              spanKind: 'agent',
              name: 'agent_b',
              metadata: {
                _dd: {
                  agent_manifest: {
                    framework: 'OpenAI',
                    name: 'agent_b',
                    instructions: 'Finish the request',
                    handoff_description: '',
                  },
                },
                output_type: 'text',
              },
              tags: { ml_app: 'test', integration: 'openai-agents' },
            }
          )
        })

        it('parents OpenAI LLMObs spans under the agent response span', async () => {
          await agentsCore.run(agent, 'hello', { maxTurns: 1 })
          const { apmSpans, llmobsSpans } = await getEvents(4)
          const responseEvent = llmobsSpans.find(s => s.name === 'test_agent (LLM)')
          const openaiEvent = llmobsSpans.find(s => s.name === 'OpenAI.createResponse')
          assertLlmObsSpanEvent(openaiEvent, {
            span: apmSpans.find(s => s.name === 'openai.request'),
            parentId: responseEvent.span_id,
            spanKind: 'llm',
            name: 'OpenAI.createResponse',
            modelName: 'gpt-4-0613',
            modelProvider: 'openai',
            inputMessages: [
              { role: 'system', content: AGENT_INSTRUCTIONS },
              { role: 'user', content: 'hello' },
            ],
            outputMessages: [
              { role: 'assistant', content: 'hello' },
            ],
            metrics: {
              input_tokens: MOCK_NOT_NULLISH,
              output_tokens: MOCK_NOT_NULLISH,
              total_tokens: MOCK_NOT_NULLISH,
              cache_read_input_tokens: MOCK_NOT_NULLISH,
              reasoning_output_tokens: MOCK_NOT_NULLISH,
            },
            metadata: {
              temperature: MOCK_NOT_NULLISH,
              stream: MOCK_NOT_NULLISH,
              top_p: MOCK_NOT_NULLISH,
              tool_choice: MOCK_NOT_NULLISH,
              truncation: MOCK_NOT_NULLISH,
              text: MOCK_NOT_NULLISH,
            },
            tags: { ml_app: 'test', integration: 'openai' },
          })
        })

        it('keeps streamed workflow output', async () => {
          const stream = await agentsCore.run(streamedAgent, 'hello', { stream: true })
          for await (const event of stream) void event
          await stream.completed
          assert.equal(stream.finalOutput, 'The capital of France is Paris.')
          const { apmSpans, llmobsSpans } = await getEvents(3)
          const workflowEvent = llmobsSpans.find(s => s.meta?.['span.kind'] === 'workflow')
          assertLlmObsSpanEvent(workflowEvent, {
            span: apmSpans.find(s => s.name === 'Agent workflow'),
            inputValue: 'hello',
            outputValue: 'The capital of France is Paris.',
            spanKind: 'workflow',
            name: 'Agent workflow',
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })

        it('includes tool calls and results in the next LLM input', async () => {
          await agentsCore.run(toolAgent, 'What is 1 + 2?', { maxTurns: 2 })
          const { llmobsSpans } = await getEvents(7)
          const llmEvents = llmobsSpans.filter(s => s.name === 'tool_agent (LLM)')
          assert.equal(llmEvents.length, 2)
          const messages = llmEvents[1].meta.input.messages
          assert.ok(messages.some(message => message.tool_calls?.[0]?.tool_id === 'call_tool' ||
            message.toolCalls?.[0]?.toolId === 'call_tool'))
          assert.ok(messages.some(message => message.tool_results?.[0]?.tool_id === 'call_tool' ||
            message.toolResults?.[0]?.toolId === 'call_tool'))
        })

        it('emits a tool span flagged as errored when the tool throws', async () => {
          // Mirrors dd-trace-py's `test_llmobs_single_agent_with_tool_errors`:
          // a `Runner.run()` flow where the model decides to call a tool that
          // throws. The SDK catches the error, surfaces it on the function
          // span, then calls the model again with the error context.
          //
          // This is the canonical error-path coverage for the
          // trace-processor architecture — direct `getResponse` /
          // `invokeFunctionTool` errors don't produce spans without going
          // through the runner.
          try {
            await agentsCore.run(toolErrorAgent, 'What is the sum of 1 and 2?', { maxTurns: 2 })
          } catch {
            // Expected: model loops on the failing tool call until maxTurns.
          }

          const { llmobsSpans } = await getEvents(5)
          const toolEvent = llmobsSpans.find(s => s.meta?.['span.kind'] === 'tool')

          assert(toolEvent, 'expected a tool span event')
          assert.strictEqual(toolEvent.meta['span.kind'], 'tool')
          assert.strictEqual(toolEvent.name, 'add')
          assert.strictEqual(toolEvent.status, 'error')
        })
      })
    }) // withVersions
  })
})
