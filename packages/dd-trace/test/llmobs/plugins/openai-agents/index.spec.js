'use strict'

const path = require('node:path')

const { withVersions } = require('../../../setup/mocha')

const {
  assertLlmObsSpanEvent,
  MOCK_NOT_NULLISH,
  MOCK_STRING,
  useLlmObs,
} = require('../../util')

describe('integrations', () => {
  describe('openai-agents LLMObs', () => {
    const { getEvents } = useLlmObs({ plugin: 'openai-agents' })

    let agentsCore
    let OpenAIResponsesModel
    let fakeModel
    let streamModel
    let errorModel
    let agent
    let errorAgent
    let targetAgent
    let testTool
    let errorTool

    withVersions('openai-agents', '@openai/agents-core', (version) => {
      before(() => {
        agentsCore = require(`../../../../../../versions/@openai/agents-core@${version}`).get()

        const { OpenAIResponsesModel: Model } =
          require(`../../../../../../versions/@openai/agents-openai@${version}`).get()
        OpenAIResponsesModel = Model

        const openaiPath = require.resolve('openai', {
          paths: [path.join(__dirname, '..', '..', '..', '..', '..', '..', 'versions', 'node_modules', '@openai', 'agents-openai')],
        })
        const { OpenAI } = require(openaiPath)

        const vcrClient = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY ?? 'test',
          baseURL: 'http://127.0.0.1:9126/vcr/openai',
        })

        // Mock client that throws errors (VCR cannot simulate network-level throws)
        const mockErrorClient = {
          baseURL: 'https://api.openai.com/v1',
          responses: {
            create: async () => {
              throw new Error('Intentional error for testing')
            },
          },
        }

        fakeModel = new OpenAIResponsesModel(vcrClient, 'gpt-4')
        streamModel = new OpenAIResponsesModel(vcrClient, 'gpt-4')
        errorModel = new OpenAIResponsesModel(mockErrorClient, 'gpt-4')

        agentsCore.setDefaultModelProvider({
          createModel: (modelName) => new OpenAIResponsesModel(vcrClient, modelName),
        })

        agent = new agentsCore.Agent({
          name: 'test_agent',
          instructions: 'You are a test agent',
          model: fakeModel,
        })

        errorAgent = new agentsCore.Agent({
          name: 'error_agent',
          instructions: 'You are an error test agent',
          model: errorModel,
        })

        targetAgent = new agentsCore.Agent({
          name: 'target_agent',
          instructions: 'You are a target agent',
          model: fakeModel,
        })

        testTool = agentsCore.tool({
          name: 'test_tool',
          description: 'A test tool',
          parameters: {},
          execute: async () => 'tool result',
        })

        errorTool = agentsCore.tool({
          name: 'error_tool',
          description: 'A tool that errors',
          parameters: {},
          execute: async () => {
            throw new Error('Intentional error for testing')
          },
        })
      })

      describe('getResponse', () => {
        it('submits an llm span for a basic getResponse call', async () => {
          await agentsCore.withTrace('test-getResponse', async () => {
            return fakeModel.getResponse({
              systemInstructions: 'You are a helpful assistant',
              input: 'Hello',
              modelSettings: { temperature: 0.7 },
              tools: [],
              outputSchema: undefined,
              handoffs: [],
              previousResponseId: undefined,
            })
          })

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'gpt-4 (LLM)',
            modelName: 'gpt-4',
            modelProvider: 'openai',
            inputMessages: [
              { role: 'system', content: 'You are a helpful assistant' },
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
            metadata: { temperature: 0.7 },
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
            })
          })

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'gpt-4 (LLM)',
            modelName: 'gpt-4',
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
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })

        it('tags input but empty output on error', async () => {
          try {
            await agentsCore.withTrace('test-getResponse-error', async () => {
              return errorModel.getResponse({
                systemInstructions: 'test',
                input: 'hello',
                modelSettings: {},
                tools: [],
                outputSchema: undefined,
                handoffs: [],
                previousResponseId: undefined,
              })
            })
          } catch {
            // Expected error
          }

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'gpt-4 (LLM)',
            modelName: 'gpt-4',
            modelProvider: 'openai',
            inputMessages: [
              { role: 'system', content: 'test' },
              { role: 'user', content: 'hello' },
            ],
            outputMessages: [{ content: '', role: '' }],
            tags: { ml_app: 'test', integration: 'openai-agents' },
            error: {
              type: 'Error',
              message: 'Intentional error for testing',
              stack: MOCK_NOT_NULLISH,
            },
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
            })
          })

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'gpt-4 (LLM)',
            modelName: 'gpt-4',
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
            metadata: { temperature: 0.5, max_tokens: 100 },
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })
      })

      describe('getStreamedResponse', () => {
        it('submits an llm span for a basic getStreamedResponse call', async () => {
          await agentsCore.withTrace('test-getStreamedResponse', async () => {
            // After orchestrion wrapping, async *getStreamedResponse returns a Promise<AsyncIterator>
            const iter = await streamModel.getStreamedResponse({
              systemInstructions: 'You are helpful',
              input: 'Stream this',
              modelSettings: { temperature: 0.3 },
              tools: [],
              outputSchema: undefined,
              handoffs: [],
              previousResponseId: undefined,
            })
            // eslint-disable-next-line no-unused-vars
            for await (const _item of iter) {
              // Consume stream
            }
          })

          const { apmSpans, llmobsSpans } = await getEvents()

          // Streaming spans finish before iteration; output is not available
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'gpt-4 (LLM)',
            modelName: 'gpt-4',
            modelProvider: 'openai',
            inputMessages: [
              { role: 'system', content: 'You are helpful' },
              { role: 'user', content: 'Stream this' },
            ],
            outputMessages: [{ content: '', role: '' }],
            metadata: { temperature: 0.3, stream: true },
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })

        it('submits an llm span for getStreamedResponse with error during iteration', async () => {
          try {
            await agentsCore.withTrace('test-getStreamedResponse-error', async () => {
              const iter = await errorModel.getStreamedResponse({
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
                // Consume stream
              }
            })
          } catch {
            // Error occurs during stream iteration, after span finishes
          }

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'gpt-4 (LLM)',
            modelName: 'gpt-4',
            modelProvider: 'openai',
            inputMessages: [
              { role: 'system', content: 'test' },
              { role: 'user', content: 'hello' },
            ],
            outputMessages: [{ content: '', role: '' }],
            metadata: { stream: true },
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })
      })

      describe('run', () => {
        it('submits a workflow span for a basic run call', async () => {
          // run() produces two LLMObs spans: llm (from getResponse, inner) and workflow (from run, outer)
          await agentsCore.run(agent, 'hello', { maxTurns: 1 })

          // run() produces two LLMObs spans: workflow (run, processed first) and llm (getResponse, second)
          // apmSpans sorted by start: [run (starts first), getResponse (starts second)]
          const { apmSpans, llmobsSpans } = await getEvents(2)

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'Agent workflow',
            inputValue: 'hello',
            outputValue: MOCK_STRING,
            metadata: MOCK_NOT_NULLISH,
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })

        it('tags input but empty output on error', async () => {
          try {
            await agentsCore.run(errorAgent, 'hello', { maxTurns: 1 })
          } catch {
            // Expected error
          }

          const { apmSpans, llmobsSpans } = await getEvents(2)

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'workflow',
            name: 'Agent workflow',
            inputValue: 'hello',
            error: {
              type: 'Error',
              message: 'Intentional error for testing',
              stack: MOCK_NOT_NULLISH,
            },
            metadata: MOCK_NOT_NULLISH,
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })
      })

      describe('invokeFunctionTool', () => {
        it('submits a tool span for a basic invokeFunctionTool call', async () => {
          await agentsCore.invokeFunctionTool({
            tool: testTool,
            runContext: new agentsCore.RunContext({ context: {} }),
            input: '{}',
            details: { toolCallId: 'test-call-id' },
          })

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'tool',
            name: 'openai-agents.invokeFunctionTool',
            inputValue: '{}',
            outputValue: 'tool result',
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })

        it('captures tool error as output value (SDK catches tool errors internally)', async () => {
          // The SDK catches tool errors and returns the error message as the output string.
          // The span is not marked as error; the error surfaces as the output value.
          await agentsCore.invokeFunctionTool({
            tool: errorTool,
            runContext: new agentsCore.RunContext({ context: {} }),
            input: '{}',
            details: { toolCallId: 'error-call-id' },
          })

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'tool',
            name: 'openai-agents.invokeFunctionTool',
            inputValue: '{}',
            outputValue: MOCK_STRING,
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })
      })

      describe('onInvokeHandoff', () => {
        it('submits an agent span for a basic onInvokeHandoff call', async () => {
          const h = agentsCore.handoff(targetAgent)
          await h.onInvokeHandoff(new agentsCore.RunContext({ context: {} }), '{}')

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'agent',
            name: 'transfer_to_target_agent',
            inputValue: '{}',
            outputValue: MOCK_STRING,
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })

        it('tags input but empty output on error', async () => {
          // Invalid JSON with inputType set triggers a ModelBehaviorError (JSON parse failure).
          // Using a non-empty input so tagTextIO records inputValue.
          const h = agentsCore.handoff(targetAgent, {
            inputType: {
              type: 'object',
              properties: { reason: { type: 'string' } },
              required: ['reason'],
              additionalProperties: false,
            },
            onHandoff: async () => {},
          })
          try {
            await h.onInvokeHandoff(new agentsCore.RunContext({ context: {} }), 'not-valid-json')
          } catch {
            // Expected ModelBehaviorError
          }

          const { apmSpans, llmobsSpans } = await getEvents()

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'agent',
            name: 'transfer_to_target_agent',
            inputValue: 'not-valid-json',
            error: true,
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })
      })

      describe('runInputGuardrails', () => {
        it('submits a task span for a basic runInputGuardrails call', async () => {
          const guardrail = {
            type: 'tool_input',
            name: 'test_input_guardrail',
            run: async () => ({ allow: true }),
          }
          await agentsCore.runToolInputGuardrails({
            guardrails: [guardrail],
            context: new agentsCore.RunContext({ context: {} }),
            agent,
            toolCall: { id: 'test-call', name: 'test_tool', arguments: '{}' },
          })

          const { apmSpans, llmobsSpans } = await getEvents()
          const expectedInput = JSON.stringify({ id: 'test-call', name: 'test_tool', arguments: '{}' })

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'task',
            name: 'openai-agents.runInputGuardrails',
            inputValue: expectedInput,
            outputValue: MOCK_STRING,
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })

        it('tags input but empty output on error', async () => {
          const guardrail = {
            type: 'tool_input',
            name: 'error_input_guardrail',
            run: async () => {
              throw new Error('Intentional error for testing')
            },
          }
          try {
            await agentsCore.runToolInputGuardrails({
              guardrails: [guardrail],
              context: new agentsCore.RunContext({ context: {} }),
              agent,
              toolCall: { id: 'test-call', name: 'test_tool', arguments: '{}' },
            })
          } catch {
            // Expected error
          }

          const { apmSpans, llmobsSpans } = await getEvents()
          const expectedInput = JSON.stringify({ id: 'test-call', name: 'test_tool', arguments: '{}' })

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'task',
            name: 'openai-agents.runInputGuardrails',
            inputValue: expectedInput,
            error: {
              type: 'Error',
              message: 'Intentional error for testing',
              stack: MOCK_NOT_NULLISH,
            },
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })
      })

      describe('runOutputGuardrails', () => {
        it('submits a task span for a basic runOutputGuardrails call', async () => {
          const guardrail = {
            type: 'tool_output',
            name: 'test_output_guardrail',
            run: async () => ({ allow: true }),
          }
          await agentsCore.runToolOutputGuardrails({
            guardrails: [guardrail],
            context: new agentsCore.RunContext({ context: {} }),
            agent,
            toolCall: { id: 'test-call', name: 'test_tool', arguments: '{}' },
            toolOutput: 'test output',
          })

          const { apmSpans, llmobsSpans } = await getEvents()
          const expectedInput = JSON.stringify({
            toolCall: { id: 'test-call', name: 'test_tool', arguments: '{}' },
            toolOutput: 'test output',
          })

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'task',
            name: 'openai-agents.runOutputGuardrails',
            inputValue: expectedInput,
            outputValue: MOCK_STRING,
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })

        it('tags input but empty output on error', async () => {
          const guardrail = {
            type: 'tool_output',
            name: 'error_output_guardrail',
            run: async () => {
              throw new Error('Intentional error for testing')
            },
          }
          try {
            await agentsCore.runToolOutputGuardrails({
              guardrails: [guardrail],
              context: new agentsCore.RunContext({ context: {} }),
              agent,
              toolCall: { id: 'test-call', name: 'test_tool', arguments: '{}' },
              toolOutput: 'test output',
            })
          } catch {
            // Expected error
          }

          const { apmSpans, llmobsSpans } = await getEvents()
          const expectedInput = JSON.stringify({
            toolCall: { id: 'test-call', name: 'test_tool', arguments: '{}' },
            toolOutput: 'test output',
          })

          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'task',
            name: 'openai-agents.runOutputGuardrails',
            inputValue: expectedInput,
            error: {
              type: 'Error',
              message: 'Intentional error for testing',
              stack: MOCK_NOT_NULLISH,
            },
            tags: { ml_app: 'test', integration: 'openai-agents' },
          })
        })
      })
    }) // withVersions
  })
})
