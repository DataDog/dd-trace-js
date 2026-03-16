'use strict'

const {
  assertLlmObsSpanEvent,
  MOCK_NOT_NULLISH,
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

    before(() => {
      // Require @openai/agents-openai FIRST so RITM patches it before @openai/agents-core
      // loads it transitively. See transitive dependency require order note in skill docs.
      const agentsOpenai = require('@openai/agents-openai')
      OpenAIResponsesModel = agentsOpenai.OpenAIResponsesModel

      agentsCore = require('@openai/agents-core')

      // Mock client returning a successful response
      const mockClient = {
        baseURL: 'https://api.openai.com/v1',
        responses: {
          create: async () => ({
            id: 'resp-001',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Hello! How can I help you?' }],
              },
            ],
            usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
          }),
        },
      }

      // Mock client for streaming
      const mockStreamClient = {
        baseURL: 'https://api.openai.com/v1',
        responses: {
          create: async () => {
            return (async function * () {
              yield {
                type: 'response.completed',
                response: {
                  id: 'resp-002',
                  output: [
                    {
                      type: 'message',
                      role: 'assistant',
                      content: [{ type: 'output_text', text: 'Streamed response' }],
                    },
                  ],
                  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                },
              }
            })()
          },
        },
      }

      // Mock client that throws errors
      const mockErrorClient = {
        baseURL: 'https://api.openai.com/v1',
        responses: {
          create: async () => {
            throw new Error('Intentional error for testing')
          },
        },
      }

      fakeModel = new OpenAIResponsesModel(mockClient, 'gpt-4')
      streamModel = new OpenAIResponsesModel(mockStreamClient, 'gpt-4')
      errorModel = new OpenAIResponsesModel(mockErrorClient, 'gpt-4')
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
          name: 'openai-agents.getResponse',
          modelName: 'gpt-4',
          modelProvider: 'openai',
          inputMessages: [
            { role: 'system', content: 'You are a helpful assistant' },
            { role: 'user', content: 'Hello' },
          ],
          outputMessages: [
            { role: 'assistant', content: 'Hello! How can I help you?' },
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
          name: 'openai-agents.getResponse',
          modelName: 'gpt-4',
          modelProvider: 'openai',
          inputMessages: [
            { role: 'user', content: 'What is 2 + 2?' },
          ],
          outputMessages: [
            { role: 'assistant', content: 'Hello! How can I help you?' },
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
          name: 'openai-agents.getResponse',
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
          name: 'openai-agents.getResponse',
          modelName: 'gpt-4',
          modelProvider: 'openai',
          inputMessages: [
            { role: 'system', content: 'You are helpful' },
            { role: 'user', content: 'Tell me a joke' },
          ],
          outputMessages: [
            { role: 'assistant', content: 'Hello! How can I help you?' },
          ],
          metrics: {
            input_tokens: MOCK_NOT_NULLISH,
            output_tokens: MOCK_NOT_NULLISH,
            total_tokens: MOCK_NOT_NULLISH,
          },
          metadata: { temperature: 0.5, maxTokens: 100 },
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
          name: 'openai-agents.getStreamedResponse',
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
          name: 'openai-agents.getStreamedResponse',
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
  })
})
