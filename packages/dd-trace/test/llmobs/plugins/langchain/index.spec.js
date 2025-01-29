'use strict'

const LLMObsAgentProxySpanWriter = require('../../../../src/llmobs/writers/spans/agentProxy')
const { useEnv } = require('../../../../../../integration-tests/helpers')
const agent = require('../../../../../dd-trace/test/plugins/agent')
const {
  expectedLLMObsLLMSpanEvent,
  expectedLLMObsNonLLMSpanEvent,
  deepEqualWithMockValues,
  MOCK_ANY,
  MOCK_STRING
} = require('../../util')
const chai = require('chai')

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

const nock = require('nock')
function stubCall ({ base = '', path = '', code = 200, response = {} }) {
  const responses = Array.isArray(response) ? response : [response]
  const times = responses.length
  nock(base).post(path).times(times).reply(() => {
    return [code, responses.shift()]
  })
}

const openAiBaseCompletionInfo = { base: 'https://api.openai.com', path: '/v1/completions' }
const openAiBaseChatInfo = { base: 'https://api.openai.com', path: '/v1/chat/completions' }
const openAiBaseEmbeddingInfo = { base: 'https://api.openai.com', path: '/v1/embeddings' }

describe('integrations', () => {
  let langchainOpenai
  let langchainAnthropic
  let langchainCohere

  let langchainMessages
  let langchainOutputParsers
  let langchainPrompts
  let langchainRunnables

  let llmobs

  // so we can verify it gets tagged properly
  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>',
    ANTHROPIC_API_KEY: '<not-a-real-key>',
    COHERE_API_KEY: '<not-a-real-key>'
  })

  describe('langchain', () => {
    before(async () => {
      sinon.stub(LLMObsAgentProxySpanWriter.prototype, 'append')

      // reduce errors related to too many listeners
      process.removeAllListeners('beforeExit')

      LLMObsAgentProxySpanWriter.prototype.append.reset()

      await agent.load('langchain', {}, {
        llmobs: {
          mlApp: 'test'
        }
      })

      llmobs = require('../../../../../..').llmobs
    })

    afterEach(() => {
      nock.cleanAll()
      LLMObsAgentProxySpanWriter.prototype.append.reset()
    })

    after(() => {
      require('../../../../../dd-trace').llmobs.disable() // unsubscribe from all events
      sinon.restore()
      return agent.close({ ritmReset: false, wipe: true })
    })

    withVersions('langchain', ['@langchain/core'], version => {
      describe('langchain', () => {
        beforeEach(() => {
          langchainOpenai = require(`../../../../../../versions/@langchain/openai@${version}`).get()
          langchainAnthropic = require(`../../../../../../versions/@langchain/anthropic@${version}`).get()
          langchainCohere = require(`../../../../../../versions/@langchain/cohere@${version}`).get()

          // need to specify specific import in `get(...)`
          langchainMessages = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('@langchain/core/messages')
          langchainOutputParsers = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('@langchain/core/output_parsers')
          langchainPrompts = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('@langchain/core/prompts')
          langchainRunnables = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('@langchain/core/runnables')
        })

        describe('llm', () => {
          it('submits an llm span for an openai llm call', async () => {
            stubCall({
              ...openAiBaseCompletionInfo,
              response: {
                choices: [
                  {
                    text: 'Hello, world!'
                  }
                ],
                usage: { prompt_tokens: 8, completion_tokens: 12, otal_tokens: 20 }
              }
            })

            const llm = new langchainOpenai.OpenAI({ model: 'gpt-3.5-turbo-instruct' })

            const checkTraces = agent.use(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                modelName: 'gpt-3.5-turbo-instruct',
                modelProvider: 'openai',
                name: 'langchain.llms.openai.OpenAI',
                inputMessages: [{ content: 'Hello!' }],
                outputMessages: [{ content: 'Hello, world!' }],
                metadata: MOCK_ANY,
                tokenMetrics: { input_tokens: 8, output_tokens: 12, total_tokens: 20 },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            await llm.invoke('Hello!')

            await checkTraces
          })

          it('does not tag output if there is an error', async () => {
            nock('https://api.openai.com').post('/v1/completions').reply(500)

            const checkTraces = agent.use(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                modelName: 'gpt-3.5-turbo-instruct',
                modelProvider: 'openai',
                name: 'langchain.llms.openai.OpenAI',
                inputMessages: [{ content: 'Hello!' }],
                outputMessages: [{ content: '' }],
                metadata: MOCK_ANY,
                tokenMetrics: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                tags: { ml_app: 'test', language: 'javascript' },
                error: 1,
                errorType: 'Error',
                errorMessage: MOCK_STRING,
                errorStack: MOCK_ANY
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            const llm = new langchainOpenai.OpenAI({ model: 'gpt-3.5-turbo-instruct', maxRetries: 0 })

            try {
              await llm.invoke('Hello!')
            } catch {}

            await checkTraces
          })

          it('submits an llm span for a cohere call', async function () {
            if (version === '0.1.0') this.skip() // cannot patch client to mock response on lower versions

            const cohere = new langchainCohere.Cohere({
              model: 'command',
              client: {
                generate () {
                  return {
                    generations: [
                      {
                        text: 'hello world!'
                      }
                    ],
                    meta: {
                      billed_units: {
                        input_tokens: 8,
                        output_tokens: 12
                      }
                    }
                  }
                }
              }
            })

            const checkTraces = agent.use(traces => {
              const span = traces[0][0]

              const spanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                modelName: 'command',
                modelProvider: 'cohere',
                name: 'langchain.llms.cohere.Cohere',
                inputMessages: [{ content: 'Hello!' }],
                outputMessages: [{ content: 'hello world!' }],
                metadata: MOCK_ANY,
                // @langchain/cohere does not provide token usage in the response
                tokenMetrics: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            await cohere.invoke('Hello!')

            await checkTraces
          })
        })

        describe('chat model', () => {
          it('submits an llm span for an openai chat model call', async () => {
            stubCall({
              ...openAiBaseChatInfo,
              response: {
                choices: [
                  {
                    message: {
                      content: 'Hello, world!',
                      role: 'assistant'
                    }
                  }
                ],
                usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 }
              }
            })

            const chat = new langchainOpenai.ChatOpenAI({ model: 'gpt-3.5-turbo' })

            const checkTraces = agent.use(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                modelName: 'gpt-3.5-turbo',
                modelProvider: 'openai',
                name: 'langchain.chat_models.openai.ChatOpenAI',
                inputMessages: [{ content: 'Hello!', role: 'user' }],
                outputMessages: [{ content: 'Hello, world!', role: 'assistant' }],
                metadata: MOCK_ANY,
                tokenMetrics: { input_tokens: 8, output_tokens: 12, total_tokens: 20 },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            await chat.invoke('Hello!')

            await checkTraces
          })

          it('does not tag output if there is an error', async () => {
            nock('https://api.openai.com').post('/v1/chat/completions').reply(500)

            const checkTraces = agent.use(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                modelName: 'gpt-3.5-turbo',
                modelProvider: 'openai',
                name: 'langchain.chat_models.openai.ChatOpenAI',
                inputMessages: [{ content: 'Hello!', role: 'user' }],
                outputMessages: [{ content: '' }],
                metadata: MOCK_ANY,
                tokenMetrics: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                tags: { ml_app: 'test', language: 'javascript' },
                error: 1,
                errorType: 'Error',
                errorMessage: MOCK_STRING,
                errorStack: MOCK_ANY
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            const chat = new langchainOpenai.ChatOpenAI({ model: 'gpt-3.5-turbo', maxRetries: 0 })

            try {
              await chat.invoke('Hello!')
            } catch {}

            await checkTraces
          })

          it('submits an llm span for an anthropic chat model call', async () => {
            stubCall({
              base: 'https://api.anthropic.com',
              path: '/v1/messages',
              response: {
                id: 'msg_01NE2EJQcjscRyLbyercys6p',
                type: 'message',
                role: 'assistant',
                model: 'claude-2.1',
                content: [
                  { type: 'text', text: 'Hello!' }
                ],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 11, output_tokens: 6 }
              }
            })

            const checkTraces = agent.use(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                modelName: 'claude-2.1', // overriden langchain for older versions
                modelProvider: 'anthropic',
                name: 'langchain.chat_models.anthropic.ChatAnthropic',
                inputMessages: [{ content: 'Hello!', role: 'user' }],
                outputMessages: [{ content: 'Hello!', role: 'assistant' }],
                metadata: MOCK_ANY,
                tokenMetrics: { input_tokens: 11, output_tokens: 6, total_tokens: 17 },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            const chatModel = new langchainAnthropic.ChatAnthropic({ model: 'claude-2.1' })

            await chatModel.invoke('Hello!')

            await checkTraces
          })

          it('submits an llm span with tool calls', async () => {
            stubCall({
              ...openAiBaseChatInfo,
              response: {
                model: 'gpt-4',
                choices: [{
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'tool-1',
                        type: 'function',
                        function: {
                          name: 'extract_fictional_info',
                          arguments: '{"name":"SpongeBob","origin":"Bikini Bottom"}'
                        }
                      }
                    ]
                  },
                  finish_reason: 'tool_calls',
                  index: 0
                }]
              }
            })

            const checkTraces = agent.use(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                modelName: 'gpt-4',
                modelProvider: 'openai',
                name: 'langchain.chat_models.openai.ChatOpenAI',
                inputMessages: [{ content: 'My name is SpongeBob and I live in Bikini Bottom.', role: 'user' }],
                outputMessages: [{
                  content: '',
                  role: 'assistant',
                  tool_calls: [{
                    arguments: {
                      name: 'SpongeBob',
                      origin: 'Bikini Bottom'
                    },
                    name: 'extract_fictional_info'
                  }]
                }],
                metadata: MOCK_ANY,
                // also tests tokens not sent on llm-type spans should be 0
                tokenMetrics: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            const tools = [
              {
                name: 'extract_fictional_info',
                description: 'Get the fictional information from the body of the input text',
                parameters: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Name of the character' },
                    origin: { type: 'string', description: 'Where they live' }
                  }
                }
              }
            ]

            const model = new langchainOpenai.ChatOpenAI({ model: 'gpt-4' })
            const modelWithTools = model.bindTools(tools)

            await modelWithTools.invoke('My name is SpongeBob and I live in Bikini Bottom.')

            await checkTraces
          })
        })

        describe('embedding', () => {
          it('submits an embedding span for an `embedQuery` call', async () => {
            stubCall({
              ...openAiBaseEmbeddingInfo,
              response: {
                object: 'list',
                data: [{
                  object: 'embedding',
                  index: 0,
                  embedding: [-0.0034387498, -0.026400521]
                }]
              }
            })
            const embeddings = new langchainOpenai.OpenAIEmbeddings()

            const checkTraces = agent.use(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'embedding',
                modelName: 'text-embedding-ada-002',
                modelProvider: 'openai',
                name: 'langchain.embeddings.openai.OpenAIEmbeddings',
                inputDocuments: [{ text: 'Hello!' }],
                outputValue: '[1 embedding(s) returned with size 2]',
                metadata: MOCK_ANY,
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            await embeddings.embedQuery('Hello!')

            await checkTraces
          })

          it('does not tag output if there is an error', async () => {
            nock('https://api.openai.com').post('/v1/embeddings').reply(500)

            const checkTraces = agent.use(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'embedding',
                modelName: 'text-embedding-ada-002',
                modelProvider: 'openai',
                name: 'langchain.embeddings.openai.OpenAIEmbeddings',
                inputDocuments: [{ text: 'Hello!' }],
                outputValue: '',
                metadata: MOCK_ANY,
                tags: { ml_app: 'test', language: 'javascript' },
                error: 1,
                errorType: 'Error',
                errorMessage: MOCK_STRING,
                errorStack: MOCK_ANY
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            const embeddings = new langchainOpenai.OpenAIEmbeddings({ maxRetries: 0 })

            try {
              await embeddings.embedQuery('Hello!')
            } catch {}

            await checkTraces
          })

          it('submits an embedding span for an `embedDocuments` call', async () => {
            stubCall({
              ...openAiBaseEmbeddingInfo,
              response: {
                object: 'list',
                data: [{
                  object: 'embedding',
                  index: 0,
                  embedding: [-0.0034387498, -0.026400521]
                }, {
                  object: 'embedding',
                  index: 1,
                  embedding: [-0.026400521, -0.0034387498]
                }]
              }
            })

            const embeddings = new langchainOpenai.OpenAIEmbeddings()

            const checkTraces = agent.use(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'embedding',
                modelName: 'text-embedding-ada-002',
                modelProvider: 'openai',
                name: 'langchain.embeddings.openai.OpenAIEmbeddings',
                inputDocuments: [{ text: 'Hello!' }, { text: 'World!' }],
                outputValue: '[2 embedding(s) returned with size 2]',
                metadata: MOCK_ANY,
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            await embeddings.embedDocuments(['Hello!', 'World!'])

            await checkTraces
          })
        })

        describe('chain', () => {
          it('submits a workflow and llm spans for a simple chain call', async () => {
            stubCall({
              ...openAiBaseCompletionInfo,
              response: {
                choices: [
                  {
                    text: 'LangSmith can help with testing in several ways.'
                  }
                ],
                usage: { prompt_tokens: 8, completion_tokens: 12, otal_tokens: 20 }
              }
            })

            const prompt = langchainPrompts.ChatPromptTemplate.fromMessages([
              ['system', 'You are a world class technical documentation writer'],
              ['user', '{input}']
            ])

            const llm = new langchainOpenai.OpenAI({ model: 'gpt-3.5-turbo-instruct' })

            const chain = prompt.pipe(llm)

            const checkTraces = agent.use(traces => {
              const spans = traces[0]
              const workflowSpan = spans[0]
              const llmSpan = spans[1]

              const workflowSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]
              const llmSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(1).args[0]

              const expectedWorkflow = expectedLLMObsNonLLMSpanEvent({
                span: workflowSpan,
                spanKind: 'workflow',
                name: 'langchain_core.runnables.RunnableSequence',
                inputValue: JSON.stringify({ input: 'Can you tell me about LangSmith?' }),
                outputValue: 'LangSmith can help with testing in several ways.',
                metadata: MOCK_ANY,
                tags: { ml_app: 'test', language: 'javascript' }
              })

              const expectedLLM = expectedLLMObsLLMSpanEvent({
                span: llmSpan,
                parentId: workflowSpan.span_id,
                spanKind: 'llm',
                modelName: 'gpt-3.5-turbo-instruct',
                modelProvider: 'openai',
                name: 'langchain.llms.openai.OpenAI',
                // this is how LangChain formats these IOs for LLMs
                inputMessages: [{
                  content: 'System: You are a world class technical documentation writer\n' +
                  'Human: Can you tell me about LangSmith?'
                }],
                outputMessages: [{ content: 'LangSmith can help with testing in several ways.' }],
                metadata: MOCK_ANY,
                tokenMetrics: { input_tokens: 8, output_tokens: 12, total_tokens: 20 },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(workflowSpanEvent).to.deepEqualWithMockValues(expectedWorkflow)

              expect(llmSpanEvent).to.deepEqualWithMockValues(expectedLLM)
            })

            await chain.invoke({ input: 'Can you tell me about LangSmith?' })

            await checkTraces
          })

          it('does not tag output if there is an error', async () => {
            nock('https://api.openai.com').post('/v1/completions').reply(500)

            const checkTraces = agent.use(traces => {
              const spans = traces[0]

              const workflowSpan = spans[0]

              const workflowSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]

              const expectedWorkflow = expectedLLMObsNonLLMSpanEvent({
                span: workflowSpan,
                spanKind: 'workflow',
                name: 'langchain_core.runnables.RunnableSequence',
                inputValue: 'Hello!',
                outputValue: '',
                metadata: MOCK_ANY,
                tags: { ml_app: 'test', language: 'javascript' },
                error: 1,
                errorType: 'Error',
                errorMessage: MOCK_STRING,
                errorStack: MOCK_ANY
              })

              expect(workflowSpanEvent).to.deepEqualWithMockValues(expectedWorkflow)
            })

            const llm = new langchainOpenai.OpenAI({ model: 'gpt-3.5-turbo-instruct', maxRetries: 0 })
            const parser = new langchainOutputParsers.StringOutputParser()
            const chain = llm.pipe(parser)

            try {
              await chain.invoke('Hello!')
            } catch {}

            await checkTraces
          })

          it('submits workflow and llm spans for a nested chain', async () => {
            stubCall({
              ...openAiBaseChatInfo,
              response: [
                {
                  choices: [
                    {
                      message: {
                        content: 'Springfield, Illinois',
                        role: 'assistant'
                      }
                    }
                  ],
                  usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 }
                },
                {
                  choices: [
                    {
                      message: {
                        content: 'Springfield, Illinois está en los Estados Unidos.',
                        role: 'assistant'
                      }
                    }
                  ],
                  usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 }
                }
              ]
            })

            const firstPrompt = langchainPrompts.ChatPromptTemplate.fromTemplate('what is the city {person} is from?')
            const secondPrompt = langchainPrompts.ChatPromptTemplate.fromTemplate(
              'what country is the city {city} in? respond in {language}'
            )

            const model = new langchainOpenai.ChatOpenAI({ model: 'gpt-3.5-turbo' })
            const parser = new langchainOutputParsers.StringOutputParser()

            const firstChain = firstPrompt.pipe(model).pipe(parser)
            const secondChain = secondPrompt.pipe(model).pipe(parser)

            const completeChain = langchainRunnables.RunnableSequence.from([
              {
                city: firstChain,
                language: input => input.language
              },
              secondChain
            ])

            const checkTraces = agent.use(traces => {
              const spans = traces[0]

              const topLevelWorkflow = spans[0]
              const firstSubWorkflow = spans[1]
              const firstLLM = spans[2]
              const secondSubWorkflow = spans[3]
              const secondLLM = spans[4]

              const topLevelWorkflowSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]
              const firstSubWorkflowSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(1).args[0]
              const firstLLMSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(2).args[0]
              const secondSubWorkflowSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(3).args[0]
              const secondLLMSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(4).args[0]

              const expectedTopLevelWorkflow = expectedLLMObsNonLLMSpanEvent({
                span: topLevelWorkflow,
                spanKind: 'workflow',
                name: 'langchain_core.runnables.RunnableSequence',
                inputValue: JSON.stringify({ person: 'Abraham Lincoln', language: 'Spanish' }),
                outputValue: 'Springfield, Illinois está en los Estados Unidos.',
                tags: { ml_app: 'test', language: 'javascript' }
              })

              const expectedFirstSubWorkflow = expectedLLMObsNonLLMSpanEvent({
                span: firstSubWorkflow,
                parentId: topLevelWorkflow.span_id,
                spanKind: 'workflow',
                name: 'langchain_core.runnables.RunnableSequence',
                inputValue: JSON.stringify({ person: 'Abraham Lincoln', language: 'Spanish' }),
                outputValue: 'Springfield, Illinois',
                tags: { ml_app: 'test', language: 'javascript' }
              })

              const expectedFirstLLM = expectedLLMObsLLMSpanEvent({
                span: firstLLM,
                parentId: firstSubWorkflow.span_id,
                spanKind: 'llm',
                modelName: 'gpt-3.5-turbo',
                modelProvider: 'openai',
                name: 'langchain.chat_models.openai.ChatOpenAI',
                inputMessages: [
                  { content: 'what is the city Abraham Lincoln is from?', role: 'user' }
                ],
                outputMessages: [{ content: 'Springfield, Illinois', role: 'assistant' }],
                metadata: MOCK_ANY,
                tokenMetrics: { input_tokens: 8, output_tokens: 12, total_tokens: 20 },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              const expectedSecondSubWorkflow = expectedLLMObsNonLLMSpanEvent({
                span: secondSubWorkflow,
                parentId: topLevelWorkflow.span_id,
                spanKind: 'workflow',
                name: 'langchain_core.runnables.RunnableSequence',
                inputValue: JSON.stringify({ language: 'Spanish', city: 'Springfield, Illinois' }),
                outputValue: 'Springfield, Illinois está en los Estados Unidos.',
                tags: { ml_app: 'test', language: 'javascript' }
              })

              const expectedSecondLLM = expectedLLMObsLLMSpanEvent({
                span: secondLLM,
                parentId: secondSubWorkflow.span_id,
                spanKind: 'llm',
                modelName: 'gpt-3.5-turbo',
                modelProvider: 'openai',
                name: 'langchain.chat_models.openai.ChatOpenAI',
                inputMessages: [
                  { content: 'what country is the city Springfield, Illinois in? respond in Spanish', role: 'user' }
                ],
                outputMessages: [{ content: 'Springfield, Illinois está en los Estados Unidos.', role: 'assistant' }],
                metadata: MOCK_ANY,
                tokenMetrics: { input_tokens: 8, output_tokens: 12, total_tokens: 20 },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(topLevelWorkflowSpanEvent).to.deepEqualWithMockValues(expectedTopLevelWorkflow)
              expect(firstSubWorkflowSpanEvent).to.deepEqualWithMockValues(expectedFirstSubWorkflow)
              expect(firstLLMSpanEvent).to.deepEqualWithMockValues(expectedFirstLLM)
              expect(secondSubWorkflowSpanEvent).to.deepEqualWithMockValues(expectedSecondSubWorkflow)
              expect(secondLLMSpanEvent).to.deepEqualWithMockValues(expectedSecondLLM)
            })

            const result = await completeChain.invoke({ person: 'Abraham Lincoln', language: 'Spanish' })
            expect(result).to.equal('Springfield, Illinois está en los Estados Unidos.')

            await checkTraces
          })

          it('submits workflow and llm spans for a batched chain', async () => {
            stubCall({
              ...openAiBaseChatInfo,
              response: [
                {
                  model: 'gpt-4',
                  usage: {
                    prompt_tokens: 37,
                    completion_tokens: 10,
                    total_tokens: 47
                  },
                  choices: [{
                    message: {
                      role: 'assistant',
                      content: 'Why did the chicken cross the road? To get to the other side!'
                    }
                  }]
                },
                {
                  model: 'gpt-4',
                  usage: {
                    prompt_tokens: 37,
                    completion_tokens: 10,
                    total_tokens: 47
                  },
                  choices: [{
                    message: {
                      role: 'assistant',
                      content: 'Why was the dog confused? It was barking up the wrong tree!'
                    }
                  }]
                }
              ]
            })

            const prompt = langchainPrompts.ChatPromptTemplate.fromTemplate(
              'Tell me a joke about {topic}'
            )
            const parser = new langchainOutputParsers.StringOutputParser()
            const model = new langchainOpenai.ChatOpenAI({ model: 'gpt-4' })

            const chain = langchainRunnables.RunnableSequence.from([
              {
                topic: new langchainRunnables.RunnablePassthrough()
              },
              prompt,
              model,
              parser
            ])

            const checkTraces = agent.use(traces => {
              const spans = traces[0]

              const workflowSpan = spans[0]
              const firstLLMSpan = spans[1]
              const secondLLMSpan = spans[2]

              const workflowSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]
              const firstLLMSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(1).args[0]
              const secondLLMSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(2).args[0]

              const expectedWorkflow = expectedLLMObsNonLLMSpanEvent({
                span: workflowSpan,
                spanKind: 'workflow',
                name: 'langchain_core.runnables.RunnableSequence',
                inputValue: JSON.stringify(['chickens', 'dogs']),
                outputValue: JSON.stringify([
                  'Why did the chicken cross the road? To get to the other side!',
                  'Why was the dog confused? It was barking up the wrong tree!'
                ]),
                tags: { ml_app: 'test', language: 'javascript' }
              })

              const expectedFirstLLM = expectedLLMObsLLMSpanEvent({
                span: firstLLMSpan,
                parentId: workflowSpan.span_id,
                spanKind: 'llm',
                modelName: 'gpt-4',
                modelProvider: 'openai',
                name: 'langchain.chat_models.openai.ChatOpenAI',
                inputMessages: [{ content: 'Tell me a joke about chickens', role: 'user' }],
                outputMessages: [{
                  content: 'Why did the chicken cross the road? To get to the other side!',
                  role: 'assistant'
                }],
                metadata: MOCK_ANY,
                tokenMetrics: { input_tokens: 37, output_tokens: 10, total_tokens: 47 },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              const expectedSecondLLM = expectedLLMObsLLMSpanEvent({
                span: secondLLMSpan,
                parentId: workflowSpan.span_id,
                spanKind: 'llm',
                modelName: 'gpt-4',
                modelProvider: 'openai',
                name: 'langchain.chat_models.openai.ChatOpenAI',
                inputMessages: [{ content: 'Tell me a joke about dogs', role: 'user' }],
                outputMessages: [{
                  content: 'Why was the dog confused? It was barking up the wrong tree!',
                  role: 'assistant'
                }],
                metadata: MOCK_ANY,
                tokenMetrics: { input_tokens: 37, output_tokens: 10, total_tokens: 47 },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(workflowSpanEvent).to.deepEqualWithMockValues(expectedWorkflow)
              expect(firstLLMSpanEvent).to.deepEqualWithMockValues(expectedFirstLLM)
              expect(secondLLMSpanEvent).to.deepEqualWithMockValues(expectedSecondLLM)
            })

            await chain.batch(['chickens', 'dogs'])

            await checkTraces
          })

          it('submits a workflow and llm spans for different schema IO', async () => {
            stubCall({
              ...openAiBaseChatInfo,
              response: {
                choices: [
                  {
                    message: {
                      content: 'Mitochondria',
                      role: 'assistant'
                    }
                  }
                ],
                usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 }
              }
            })

            const prompt = langchainPrompts.ChatPromptTemplate.fromMessages([
              ['system', 'You are an assistant who is good at {ability}. Respond in 20 words or fewer'],
              new langchainPrompts.MessagesPlaceholder('history'),
              ['human', '{input}']
            ])

            const model = new langchainOpenai.ChatOpenAI({ model: 'gpt-3.5-turbo' })
            const chain = prompt.pipe(model)

            const checkTraces = agent.use(traces => {
              const spans = traces[0]

              const workflowSpan = spans[0]
              const llmSpan = spans[1]

              const workflowSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]
              const llmSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(1).args[0]

              const expectedWorkflow = expectedLLMObsNonLLMSpanEvent({
                span: workflowSpan,
                spanKind: 'workflow',
                name: 'langchain_core.runnables.RunnableSequence',
                inputValue: JSON.stringify({
                  ability: 'world capitals',
                  history: [
                    {
                      content: 'Can you be my science teacher instead?',
                      role: 'user'
                    },
                    {
                      content: 'Yes',
                      role: 'assistant'
                    }
                  ],
                  input: 'What is the powerhouse of the cell?'
                }),
                // takes the form of an AIMessage struct since there is no output parser
                outputValue: JSON.stringify({
                  content: 'Mitochondria',
                  role: 'assistant'
                }),
                tags: { ml_app: 'test', language: 'javascript' }
              })

              const expectedLLM = expectedLLMObsLLMSpanEvent({
                span: llmSpan,
                parentId: workflowSpan.span_id,
                spanKind: 'llm',
                modelName: 'gpt-3.5-turbo',
                modelProvider: 'openai',
                name: 'langchain.chat_models.openai.ChatOpenAI',
                inputMessages: [
                  {
                    content: 'You are an assistant who is good at world capitals. Respond in 20 words or fewer',
                    role: 'system'
                  },
                  {
                    content: 'Can you be my science teacher instead?',
                    role: 'user'
                  },
                  {
                    content: 'Yes',
                    role: 'assistant'
                  },
                  {
                    content: 'What is the powerhouse of the cell?',
                    role: 'user'
                  }
                ],
                outputMessages: [{ content: 'Mitochondria', role: 'assistant' }],
                metadata: MOCK_ANY,
                tokenMetrics: { input_tokens: 8, output_tokens: 12, total_tokens: 20 },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(workflowSpanEvent).to.deepEqualWithMockValues(expectedWorkflow)
              expect(llmSpanEvent).to.deepEqualWithMockValues(expectedLLM)
            })

            await chain.invoke({
              ability: 'world capitals',
              history: [
                new langchainMessages.HumanMessage('Can you be my science teacher instead?'),
                new langchainMessages.AIMessage('Yes')
              ],
              input: 'What is the powerhouse of the cell?'
            })

            await checkTraces
          })

          it('traces a manually-instrumented step', async () => {
            stubCall({
              ...openAiBaseChatInfo,
              response: {
                choices: [
                  {
                    message: {
                      content: '3 squared is 9',
                      role: 'assistant'
                    }
                  }
                ],
                usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 }
              }
            })

            let lengthFunction = (input = { foo: '' }) => {
              llmobs.annotate({ inputData: input }) // so we don't try and tag `config` with auto-annotation
              return {
                length: input.foo.length.toString()
              }
            }
            lengthFunction = llmobs.wrap({ kind: 'task' }, lengthFunction)

            const model = new langchainOpenai.ChatOpenAI({ model: 'gpt-4o' })

            const prompt = langchainPrompts.ChatPromptTemplate.fromTemplate('What is {length} squared?')

            const chain = langchainRunnables.RunnableLambda.from(lengthFunction)
              .pipe(prompt)
              .pipe(model)
              .pipe(new langchainOutputParsers.StringOutputParser())

            const checkTraces = agent.use(traces => {
              const spans = traces[0]
              expect(spans.length).to.equal(3)

              const workflowSpan = spans[0]
              const taskSpan = spans[1]
              const llmSpan = spans[2]

              const workflowSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]
              const taskSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(1).args[0]
              const llmSpanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(2).args[0]

              const expectedWorkflow = expectedLLMObsNonLLMSpanEvent({
                span: workflowSpan,
                spanKind: 'workflow',
                name: 'langchain_core.runnables.RunnableSequence',
                inputValue: JSON.stringify({ foo: 'bar' }),
                outputValue: '3 squared is 9',
                tags: { ml_app: 'test', language: 'javascript' }
              })

              const expectedTask = expectedLLMObsNonLLMSpanEvent({
                span: taskSpan,
                parentId: workflowSpan.span_id,
                spanKind: 'task',
                name: 'lengthFunction',
                inputValue: JSON.stringify({ foo: 'bar' }),
                outputValue: JSON.stringify({ length: '3' }),
                tags: { ml_app: 'test', language: 'javascript' }
              })

              const expectedLLM = expectedLLMObsLLMSpanEvent({
                span: llmSpan,
                parentId: workflowSpan.span_id,
                spanKind: 'llm',
                modelName: 'gpt-4o',
                modelProvider: 'openai',
                name: 'langchain.chat_models.openai.ChatOpenAI',
                inputMessages: [{ content: 'What is 3 squared?', role: 'user' }],
                outputMessages: [{ content: '3 squared is 9', role: 'assistant' }],
                metadata: MOCK_ANY,
                tokenMetrics: { input_tokens: 8, output_tokens: 12, total_tokens: 20 },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(workflowSpanEvent).to.deepEqualWithMockValues(expectedWorkflow)
              expect(taskSpanEvent).to.deepEqualWithMockValues(expectedTask)
              expect(llmSpanEvent).to.deepEqualWithMockValues(expectedLLM)
            })

            await chain.invoke({ foo: 'bar' })

            await checkTraces
          })
        })
      })
    })
  })
})
