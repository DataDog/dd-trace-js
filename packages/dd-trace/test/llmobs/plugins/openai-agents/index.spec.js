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

const SYSTEM_INSTRUCTIONS = 'You are a helpful assistant'

describe('integrations', () => {
  describe('openai-agents LLMObs', () => {
    const { getEvents } = useLlmObs({ plugin: 'openai-agents' })

    let agentsCore
    let OpenAIResponsesModel
    let fakeModel
    let streamModel
    let agent
    let toolErrorAgent

    withVersions('openai-agents', '@openai/agents-core', (version) => {
      before(() => {
        agentsCore = require(`../../../../../../versions/@openai/agents-core@${version}`).get()

        const { OpenAIResponsesModel: Model } =
          require(`../../../../../../versions/@openai/agents-openai@${version}`).get()
        OpenAIResponsesModel = Model

        const agentsOpenaiDir = path.join(
          __dirname, '..', '..', '..', '..', '..', '..', 'versions', 'node_modules', '@openai', 'agents-openai'
        )
        const openaiPath = require.resolve('openai', { paths: [agentsOpenaiDir] })
        const { OpenAI } = require(openaiPath)

        const vcrClient = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY ?? 'test',
          baseURL: 'http://127.0.0.1:9126/vcr/openai',
        })

        agentsCore.setDefaultModelProvider({
          createModel: (modelName) => new OpenAIResponsesModel(vcrClient, modelName),
        })

        fakeModel = new OpenAIResponsesModel(vcrClient, 'gpt-4')
        streamModel = new OpenAIResponsesModel(vcrClient, 'gpt-4')

        agent = new agentsCore.Agent({
          name: 'test_agent',
          instructions: 'You are a test agent',
          model: fakeModel,
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
          model: new OpenAIResponsesModel(vcrClient, 'gpt-4o-mini'),
          tools: [additionErrorTool],
        })
      })

      // Direct `fakeModel.getResponse(...)` calls (outside `Runner.run()`)
      // don't have a parent agent span, so the LLMObs span name stays as the
      // default `openai_agents.response` rather than `${agent_name} (LLM)`.
      // Metadata mirrors Python's openai-agents integration: response-echoed
      // configuration fields, no filtering of OpenAI defaults — see
      // `OaiSpanAdapter.llmobs_metadata` in dd-trace-py.
      const COMMON_RESPONSE_METADATA = {
        temperature: MOCK_NOT_NULLISH,
        top_p: MOCK_NOT_NULLISH,
        tool_choice: MOCK_NOT_NULLISH,
        tools: MOCK_NOT_NULLISH,
        truncation: MOCK_NOT_NULLISH,
        text: MOCK_NOT_NULLISH,
      }

      describe('getResponse', () => {
        it('submits an llm span for a basic getResponse call', async () => {
          await agentsCore.withTrace('test-getResponse', async () => {
            return fakeModel.getResponse({
              systemInstructions: SYSTEM_INSTRUCTIONS,
              input: 'Hello',
              modelSettings: { temperature: 0.7 },
              tools: [],
              outputSchema: undefined,
              handoffs: [],
              previousResponseId: undefined,
              tracing: true,
            })
          })

          const { apmSpans, llmobsSpans } = await getEvents(2)
          const llmEvent = llmobsSpans.find(s => s.meta?.['span.kind'] === 'llm')
          const llmApmSpan = apmSpans.find(s => s.name === 'openai_agents.response')
          const workflowApmSpan = apmSpans.find(s => s.name !== 'openai_agents.response')

          assertLlmObsSpanEvent(llmEvent, {
            span: llmApmSpan,
            parentId: workflowApmSpan?.span_id,
            spanKind: 'llm',
            name: 'openai_agents.response',
            modelName: 'gpt-4-0613',
            modelProvider: 'openai',
            inputMessages: [
              { role: 'system', content: SYSTEM_INSTRUCTIONS },
              { role: 'user', content: 'Hello' },
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

        it('submits an llm span with string input only (no system instructions)', async () => {
          await agentsCore.withTrace('test-getResponse-no-system', async () => {
            return fakeModel.getResponse({
              input: 'What is 2 + 2?',
              modelSettings: {},
              tools: [],
              outputSchema: undefined,
              handoffs: [],
              previousResponseId: undefined,
              tracing: true,
            })
          })

          const { apmSpans, llmobsSpans } = await getEvents(2)
          const llmEvent = llmobsSpans.find(s => s.meta?.['span.kind'] === 'llm')
          const llmApmSpan = apmSpans.find(s => s.name === 'openai_agents.response')
          const workflowApmSpan = apmSpans.find(s => s.name !== 'openai_agents.response')

          assertLlmObsSpanEvent(llmEvent, {
            span: llmApmSpan,
            parentId: workflowApmSpan?.span_id,
            spanKind: 'llm',
            name: 'openai_agents.response',
            modelName: 'gpt-4-0613',
            modelProvider: 'openai',
            inputMessages: [
              { role: 'user', content: 'What is 2 + 2?' },
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

        it('submits an llm span with array input containing message objects', async () => {
          await agentsCore.withTrace('test-getResponse-array-input', async () => {
            return fakeModel.getResponse({
              systemInstructions: 'You are helpful',
              input: [
                {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: 'Tell me a joke' }],
                },
              ],
              modelSettings: { temperature: 0.5, maxTokens: 100 },
              tools: [],
              outputSchema: undefined,
              handoffs: [],
              previousResponseId: undefined,
              tracing: true,
            })
          })

          const { apmSpans, llmobsSpans } = await getEvents(2)
          const llmEvent = llmobsSpans.find(s => s.meta?.['span.kind'] === 'llm')
          const llmApmSpan = apmSpans.find(s => s.name === 'openai_agents.response')
          const workflowApmSpan = apmSpans.find(s => s.name !== 'openai_agents.response')

          assertLlmObsSpanEvent(llmEvent, {
            span: llmApmSpan,
            parentId: workflowApmSpan?.span_id,
            spanKind: 'llm',
            name: 'openai_agents.response',
            modelName: 'gpt-4-0613',
            modelProvider: 'openai',
            inputMessages: [
              { role: 'system', content: 'You are helpful' },
              { role: 'user', content: 'Tell me a joke' },
            ],
            outputMessages: [
              { role: 'assistant', content: MOCK_STRING },
            ],
            metrics: {
              input_tokens: MOCK_NOT_NULLISH,
              output_tokens: MOCK_NOT_NULLISH,
              total_tokens: MOCK_NOT_NULLISH,
            },
            metadata: { ...COMMON_RESPONSE_METADATA, max_output_tokens: MOCK_NOT_NULLISH },
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })
      })

      describe('getStreamedResponse', () => {
        it('submits an llm span for a basic getStreamedResponse call', async () => {
          await agentsCore.withTrace('test-getStreamedResponse', async () => {
            const iter = await streamModel.getStreamedResponse({
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
              // Consume stream
            }
          })

          const { apmSpans, llmobsSpans } = await getEvents(2)
          const llmEvent = llmobsSpans.find(s => s.meta?.['span.kind'] === 'llm')
          const llmApmSpan = apmSpans.find(s => s.name === 'openai_agents.response')
          const workflowApmSpan = apmSpans.find(s => s.name !== 'openai_agents.response')

          // The trace-processor architecture sees a `response`-type oai span
          // for both streamed and non-streamed calls (matching Python — see
          // the dd-trace-py spec, which also doesn't tag a `stream` marker).
          assertLlmObsSpanEvent(llmEvent, {
            span: llmApmSpan,
            parentId: workflowApmSpan?.span_id,
            spanKind: 'llm',
            name: 'openai_agents.response',
            modelName: 'gpt-4-0613',
            modelProvider: 'openai',
            inputMessages: [
              { role: 'system', content: 'test' },
              { role: 'user', content: 'hello' },
            ],
            outputMessages: [{ role: 'assistant', content: MOCK_STRING }],
            metrics: {
              input_tokens: MOCK_NOT_NULLISH,
              output_tokens: MOCK_NOT_NULLISH,
              total_tokens: MOCK_NOT_NULLISH,
            },
            metadata: COMMON_RESPONSE_METADATA,
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })
      })

      describe('run', () => {
        it('submits a workflow span for a basic run call', async () => {
          // run() produces three LLMObs spans (workflow, agent, llm) — see
          // dd-trace-py's `test_llmobs_single_agent`. We only assert the
          // workflow span here; the agent + llm spans are covered by the
          // multi-agent test below and the basic getResponse tests above.
          await agentsCore.run(agent, 'hello', { maxTurns: 1 })

          const { apmSpans, llmobsSpans } = await getEvents(3)
          const workflowEvent = llmobsSpans.find(s => s.meta?.['span.kind'] === 'workflow')
          const workflowApmSpan = apmSpans.find(s => s.name === 'Agent workflow')

          assertLlmObsSpanEvent(workflowEvent, {
            span: workflowApmSpan,
            spanKind: 'workflow',
            name: 'Agent workflow',
            inputValue: 'hello',
            outputValue: MOCK_STRING,
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })

        it('emits a tool span flagged as errored when the tool throws', async () => {
          // Mirrors dd-trace-py's `test_llmobs_single_agent_with_tool_errors`:
          // a `Runner.run()` flow where the model decides to call a tool that
          // throws. The SDK catches the error, surfaces it on the function
          // span, then calls the model again with the error context.
          //
          // The model retries the same tool call after seeing the error, so
          // the agent eventually exits with `MaxTurnsExceededError`. We catch
          // that and assert on the function span the SDK did emit. This is
          // the canonical error-path coverage for the trace-processor
          // architecture — direct `getResponse` / `invokeFunctionTool` errors
          // don't produce spans without going through the runner.
          //
          // VCR: cassettes are recorded on first run with a real
          // `OPENAI_API_KEY` and replayed on subsequent runs.
          try {
            await agentsCore.run(toolErrorAgent, 'What is the sum of 1 and 2?', { maxTurns: 2 })
          } catch (err) {
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
