'use strict'

const { useEnv } = require('../../../integration-tests/helpers')
const agent = require('../../dd-trace/test/plugins/agent')
const iastFilter = require('../../dd-trace/src/appsec/iast/taint-tracking/filter')

const nock = require('nock')
const semver = require('semver')
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

const isDdTrace = iastFilter.isDdTrace

describe('Plugin', () => {
  let langchainOpenai
  let langchainAnthropic
  let langchainGoogleGenAI

  let langchainMessages
  let langchainOutputParsers
  let langchainPrompts
  let langchainRunnables

  /**
   * In OpenAI 4.91.0, the default response format for embeddings was changed from `float` to `base64`.
   * We do not have control in @langchain/openai embeddings to change this for an individual call,
   * so we need to check the version and stub the response accordingly. If the OpenAI version installed with
   * @langchain/openai is less than 4.91.0, we stub the response to be a float array of zeros.
   * If it is 4.91.0 or greater, we stub with a pre-recorded fixture of a 1536 base64 encoded embedding.
   */
  let langchainOpenaiOpenAiVersion

  // so we can verify it gets tagged properly
  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>',
    ANTHROPIC_API_KEY: '<not-a-real-key>',
    GOOGLE_API_KEY: '<not-a-real-key>'
  })

  describe('langchain', () => {
    // TODO(sabrenner): remove this once we have the more robust mocking merged
    withVersions('langchain', ['@langchain/core'], '<0.3.60', version => {
      before(() => {
        iastFilter.isDdTrace = file => {
          if (file.includes('dd-trace-js/versions/')) {
            return false
          }
          return isDdTrace(file)
        }
        return agent.load('langchain')
      })

      after(() => {
        iastFilter.isDdTrace = isDdTrace
        // wiping in order to read new env vars for the config each time
        return agent.close({ ritmReset: false })
      })

      beforeEach(() => {
        langchainOpenai = require(`../../../versions/@langchain/openai@${version}`).get()
        langchainAnthropic = require(`../../../versions/@langchain/anthropic@${version}`).get()
        if (version !== '0.1.0') {
          // version mismatching otherwise
          // can probably scaffold `withVersions` better to make this a bit cleaner
          langchainGoogleGenAI = require(`../../../versions/@langchain/google-genai@${version}`).get()
        }

        // need to specify specific import in `get(...)`
        langchainMessages = require(`../../../versions/@langchain/core@${version}`).get('@langchain/core/messages')
        langchainOutputParsers = require(`../../../versions/@langchain/core@${version}`)
          .get('@langchain/core/output_parsers')
        langchainPrompts = require(`../../../versions/@langchain/core@${version}`).get('@langchain/core/prompts')
        langchainRunnables = require(`../../../versions/@langchain/core@${version}`).get('@langchain/core/runnables')

        langchainOpenaiOpenAiVersion =
            require(`../../../versions/@langchain/openai@${version}`)
              .get('openai/version')
              .VERSION
      })

      afterEach(() => {
        nock.cleanAll()
      })

      describe('llm', () => {
        it('does not tag output on error', async () => {
          nock('https://api.openai.com').post('/v1/completions').reply(403)

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)

              const span = traces[0][0]

              const langchainResponseRegex = /^langchain\.response\.completions\./
              const hasMatching = Object.keys(span.meta).some(key => langchainResponseRegex.test(key))

              expect(hasMatching).to.be.false

              expect(span.meta).to.have.property('error.message')
              expect(span.meta).to.have.property('error.type')
              expect(span.meta).to.have.property('error.stack')
            })

          try {
            const llm = new langchainOpenai.OpenAI({ model: 'gpt-3.5-turbo-instruct', maxRetries: 0 })
            await llm.generate(['what is 2 + 2?'])
          } catch {}

          await checkTraces
        })

        it('instruments a langchain llm call for a single prompt', async () => {
          stubCall({
            ...openAiBaseCompletionInfo,
            response: {
              model: 'gpt-3.5-turbo-instruct',
              choices: [{
                text: 'The answer is 4',
                index: 0,
                logprobs: null,
                finish_reason: 'length'
              }],
              usage: { prompt_tokens: 8, completion_tokens: 12, otal_tokens: 20 }
            }
          })

          const llm = new langchainOpenai.OpenAI({ model: 'gpt-3.5-turbo-instruct' })
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span).to.have.property('name', 'langchain.request')
              expect(span).to.have.property('resource', 'langchain.llms.openai.OpenAI')

              expect(span.meta).to.have.property('langchain.request.api_key', '...key>')
              expect(span.meta).to.have.property('langchain.request.provider', 'openai')
              expect(span.meta).to.have.property('langchain.request.model', 'gpt-3.5-turbo-instruct')
              expect(span.meta).to.have.property('langchain.request.type', 'llm')
              expect(span.meta).to.have.property('langchain.request.prompts.0.content', 'what is 2 + 2?')

              expect(span.meta).to.have.property('langchain.response.completions.0.text', 'The answer is 4')
              expect(span.meta).to.have.property('langchain.response.completions.0.finish_reason', 'length')

              expect(span.metrics).to.have.property('langchain.tokens.input_tokens', 8)
              expect(span.metrics).to.have.property('langchain.tokens.output_tokens', 12)
              expect(span.metrics).to.have.property('langchain.tokens.total_tokens', 20)
            })

          const result = await llm.generate(['what is 2 + 2?'])

          expect(result.generations[0][0].text).to.equal('The answer is 4')

          await checkTraces
        })

        it('instruments a langchain openai llm call for multiple prompts', async () => {
          stubCall({
            ...openAiBaseCompletionInfo,
            response: {
              model: 'gpt-3.5-turbo-instruct',
              choices: [{
                text: 'The answer is 4',
                index: 0,
                logprobs: null,
                finish_reason: 'length'
              }, {
                text: 'The circumference of the earth is 24,901 miles',
                index: 1,
                logprobs: null,
                finish_reason: 'length'
              }],
              usage: { prompt_tokens: 8, completion_tokens: 12, otal_tokens: 20 }
            }
          })

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span.meta).to.have.property('langchain.request.prompts.0.content', 'what is 2 + 2?')
              expect(span.meta).to.have.property(
                'langchain.request.prompts.1.content', 'what is the circumference of the earth?')

              expect(span.meta).to.have.property('langchain.response.completions.0.text', 'The answer is 4')
              expect(span.meta).to.have.property(
                'langchain.response.completions.1.text', 'The circumference of the earth is 24,901 miles')
            })

          const llm = new langchainOpenai.OpenAI({ model: 'gpt-3.5-turbo-instruct' })
          const result = await llm.generate(['what is 2 + 2?', 'what is the circumference of the earth?'])

          expect(result.generations[0][0].text).to.equal('The answer is 4')
          expect(result.generations[1][0].text).to.equal('The circumference of the earth is 24,901 miles')

          await checkTraces
        })

        it('instruments a langchain openai llm call for a single prompt and multiple responses', async () => {
          // it should only use the first choice
          stubCall({
            ...openAiBaseCompletionInfo,
            response: {
              model: 'gpt-3.5-turbo-instruct',
              choices: [{
                text: 'The answer is 4',
                index: 0,
                logprobs: null,
                finish_reason: 'length'
              }, {
                text: '2 + 2 = 4',
                index: 1,
                logprobs: null,
                finish_reason: 'length'
              }],
              usage: { prompt_tokens: 8, completion_tokens: 12, otal_tokens: 20 }
            }
          })

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span.metrics).to.have.property('langchain.request.openai.parameters.n', 2)

              expect(span.meta).to.have.property('langchain.request.prompts.0.content', 'what is 2 + 2?')
              expect(span.meta).to.have.property('langchain.response.completions.0.text', 'The answer is 4')

              expect(span.meta).to.not.have.property('langchain.response.completions.1.text')
            })

          const llm = new langchainOpenai.OpenAI({ model: 'gpt-3.5-turbo-instruct', n: 2 })
          const result = await llm.generate(['what is 2 + 2?'])

          expect(result.generations[0][0].text).to.equal('The answer is 4')
          expect(result.generations[0][1].text).to.equal('2 + 2 = 4')

          await checkTraces
        })
      })

      describe('chat model', () => {
        it('does not tag output on error', async () => {
          nock('https://api.openai.com').post('/v1/chat/completions').reply(403)

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)

              const span = traces[0][0]

              const langchainResponseRegex = /^langchain\.response\.completions\./
              const hasMatching = Object.keys(span.meta).some(key => langchainResponseRegex.test(key))
              expect(hasMatching).to.be.false

              expect(span.meta).to.have.property('error.message')
              expect(span.meta).to.have.property('error.type')
              expect(span.meta).to.have.property('error.stack')
            })

          try {
            const chatModel = new langchainOpenai.ChatOpenAI({ model: 'gpt-4', maxRetries: 0 })
            await chatModel.invoke('Hello!')
          } catch {}

          await checkTraces
        })

        it('instruments a langchain openai chat model call for a single string prompt', async () => {
          stubCall({
            ...openAiBaseChatInfo,
            response: {
              model: 'gpt-4',
              usage: {
                prompt_tokens: 37,
                completion_tokens: 10,
                total_tokens: 47
              },
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'Hello! How can I assist you today?'
                },
                finish_reason: 'length',
                index: 0
              }]
            }
          })

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span).to.have.property('name', 'langchain.request')
              expect(span).to.have.property('resource', 'langchain.chat_models.openai.ChatOpenAI')

              expect(span.meta).to.have.property('langchain.request.api_key', '...key>')
              expect(span.meta).to.have.property('langchain.request.provider', 'openai')
              expect(span.meta).to.have.property('langchain.request.model', 'gpt-4')
              expect(span.meta).to.have.property('langchain.request.type', 'chat_model')

              expect(span.meta).to.have.property('langchain.request.messages.0.0.content', 'Hello!')
              expect(span.meta).to.have.property('langchain.request.messages.0.0.message_type', 'HumanMessage')

              expect(span.meta).to.have.property(
                'langchain.response.completions.0.0.content', 'Hello! How can I assist you today?'
              )
              expect(span.meta).to.have.property('langchain.response.completions.0.0.message_type', 'AIMessage')

              expect(span.metrics).to.have.property('langchain.tokens.input_tokens', 37)
              expect(span.metrics).to.have.property('langchain.tokens.output_tokens', 10)
              expect(span.metrics).to.have.property('langchain.tokens.total_tokens', 47)
            })

          const chatModel = new langchainOpenai.ChatOpenAI({ model: 'gpt-4' })
          const result = await chatModel.invoke('Hello!')

          expect(result.content).to.equal('Hello! How can I assist you today?')

          await checkTraces
        })

        it('instruments a langchain openai chat model call for a JSON message input', async () => {
          stubCall({
            ...openAiBaseChatInfo,
            response: {
              model: 'gpt-4',
              usage: {
                prompt_tokens: 37,
                completion_tokens: 10,
                total_tokens: 47
              },
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'Hi!'
                },
                finish_reason: 'length',
                index: 0
              }]
            }
          })

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span.meta).to.have.property(
                'langchain.request.messages.0.0.content', 'You only respond with one word answers'
              )
              expect(span.meta).to.have.property('langchain.request.messages.0.0.message_type', 'SystemMessage')
              expect(span.meta).to.have.property('langchain.request.messages.0.1.content', 'Hello!')
              expect(span.meta).to.have.property('langchain.request.messages.0.1.message_type', 'HumanMessage')

              expect(span.meta).to.have.property('langchain.response.completions.0.0.content', 'Hi!')
              expect(span.meta).to.have.property('langchain.response.completions.0.0.message_type', 'AIMessage')
            })

          const chatModel = new langchainOpenai.ChatOpenAI({ model: 'gpt-4' })
          const messages = [
            { role: 'system', content: 'You only respond with one word answers' },
            { role: 'human', content: 'Hello!' }
          ]

          const result = await chatModel.invoke(messages)
          expect(result.content).to.equal('Hi!')

          await checkTraces
        })

        it('instruments a langchain openai chat model call for a BaseMessage-like input', async () => {
          stubCall({
            ...openAiBaseChatInfo,
            response: {
              model: 'gpt-4',
              usage: {
                prompt_tokens: 37,
                completion_tokens: 10,
                total_tokens: 47
              },
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'Hi!'
                },
                finish_reason: 'length',
                index: 0
              }]
            }
          })

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span.meta).to.have.property(
                'langchain.request.messages.0.0.content', 'You only respond with one word answers'
              )
              expect(span.meta).to.have.property('langchain.request.messages.0.0.message_type', 'SystemMessage')
              expect(span.meta).to.have.property('langchain.request.messages.0.1.content', 'Hello!')
              expect(span.meta).to.have.property('langchain.request.messages.0.1.message_type', 'HumanMessage')

              expect(span.meta).to.have.property(
                'langchain.response.completions.0.0.content', 'Hi!'
              )
              expect(span.meta).to.have.property('langchain.response.completions.0.0.message_type', 'AIMessage')
            })

          const chatModel = new langchainOpenai.ChatOpenAI({ model: 'gpt-4' })
          const messages = [
            new langchainMessages.SystemMessage('You only respond with one word answers'),
            new langchainMessages.HumanMessage('Hello!')
          ]
          const result = await chatModel.invoke(messages)

          expect(result.content).to.equal('Hi!')

          await checkTraces
        })

        it('instruments a langchain openai chat model call with tool calls', async () => {
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

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span.meta).to.have.property(
                'langchain.request.messages.0.0.content', 'My name is SpongeBob and I live in Bikini Bottom.'
              )
              expect(span.meta).to.have.property('langchain.request.messages.0.0.message_type', 'HumanMessage')
              expect(span.meta).to.not.have.property('langchain.response.completions.0.0.content')
              expect(span.meta).to.have.property('langchain.response.completions.0.0.message_type', 'AIMessage')
              expect(span.meta).to.have.property('langchain.response.completions.0.0.tool_calls.0.id', 'tool-1')
              expect(span.meta).to.have.property(
                'langchain.response.completions.0.0.tool_calls.0.name', 'extract_fictional_info'
              )
              expect(span.meta).to.have.property(
                'langchain.response.completions.0.0.tool_calls.0.args.name', 'SpongeBob'
              )
              expect(span.meta).to.have.property(
                'langchain.response.completions.0.0.tool_calls.0.args.origin', 'Bikini Bottom'
              )
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

          const result = await modelWithTools.invoke('My name is SpongeBob and I live in Bikini Bottom.')
          expect(result.tool_calls).to.have.length(1)
          expect(result.tool_calls[0].name).to.equal('extract_fictional_info')

          await checkTraces
        })

        it('instruments a langchain anthropic chat model call', async () => {
          stubCall({
            base: 'https://api.anthropic.com',
            path: '/v1/messages',
            response: {
              id: 'msg_01NE2EJQcjscRyLbyercys6p',
              type: 'message',
              role: 'assistant',
              model: 'claude-3-opus-20240229',
              content: [
                { type: 'text', text: 'Hello!' }
              ],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 11, output_tokens: 6 }
            }
          })

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span).to.have.property('name', 'langchain.request')
              expect(span).to.have.property('resource', 'langchain.chat_models.anthropic.ChatAnthropic')

              expect(span.meta).to.have.property('langchain.request.api_key', '...key>')
              expect(span.meta).to.have.property('langchain.request.provider', 'anthropic')
              expect(span.meta).to.have.property('langchain.request.model')
              expect(span.meta).to.have.property('langchain.request.type', 'chat_model')

              expect(span.meta).to.have.property('langchain.request.messages.0.0.content', 'Hello!')
              expect(span.meta).to.have.property('langchain.request.messages.0.0.message_type', 'HumanMessage')

              expect(span.meta).to.have.property('langchain.response.completions.0.0.content', 'Hello!')
              expect(span.meta).to.have.property('langchain.response.completions.0.0.message_type', 'AIMessage')
            })

          const chatModel = new langchainAnthropic.ChatAnthropic({ model: 'claude-3-opus-20240229' })

          const result = await chatModel.invoke('Hello!')
          expect(result.content).to.equal('Hello!')

          await checkTraces
        })
      })

      describe('chain', () => {
        it('does not tag output on error', async () => {
          nock('https://api.openai.com').post('/v1/chat/completions').reply(403)

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(2)

              const chainSpan = traces[0][0]

              const langchainResponseRegex = /^langchain\.response\.outputs\./

              const hasMatching = Object.keys(chainSpan.meta).some(key => langchainResponseRegex.test(key))
              expect(hasMatching).to.be.false

              expect(chainSpan.meta).to.have.property('error.message')
              expect(chainSpan.meta).to.have.property('error.type')
              expect(chainSpan.meta).to.have.property('error.stack')
            })

          try {
            const model = new langchainOpenai.ChatOpenAI({ model: 'gpt-4', maxRetries: 0 })
            const parser = new langchainOutputParsers.StringOutputParser()

            const chain = model.pipe(parser)

            await chain.invoke('Hello!')
          } catch {}

          await checkTraces
        })

        it('instruments a langchain chain with a single openai chat model call', async () => {
          stubCall({
            ...openAiBaseChatInfo,
            response: {
              model: 'gpt-4',
              usage: {
                prompt_tokens: 37,
                completion_tokens: 10,
                total_tokens: 47
              },
              choices: [{
                message: {
                  role: 'assistant',
                  content: 'Hi!'
                },
                finish_reason: 'length',
                index: 0
              }]
            }
          })

          const checkTraces = agent
            .assertSomeTraces(traces => {
              const spans = traces[0]
              expect(spans).to.have.length(2)

              const chainSpan = spans[0]
              // we already check the chat model span in previous tests
              expect(spans[1]).to.have.property('resource', 'langchain.chat_models.openai.ChatOpenAI')

              expect(chainSpan).to.have.property('name', 'langchain.request')
              expect(chainSpan).to.have.property('resource', 'langchain_core.runnables.RunnableSequence')

              expect(chainSpan.meta).to.have.property('langchain.request.type', 'chain')

              expect(chainSpan.meta).to.have.property(
                'langchain.request.inputs.0.content', 'You only respond with one word answers'
              )
              expect(chainSpan.meta).to.have.property('langchain.request.inputs.1.content', 'Hello!')

              expect(chainSpan.meta).to.have.property('langchain.response.outputs.0', 'Hi!')
            })

          const model = new langchainOpenai.ChatOpenAI({ model: 'gpt-4' })
          const parser = new langchainOutputParsers.StringOutputParser()

          const chain = model.pipe(parser)
          const messages = [
            new langchainMessages.SystemMessage('You only respond with one word answers'),
            new langchainMessages.HumanMessage('Hello!')
          ]
          const result = await chain.invoke(messages)

          expect(result).to.equal('Hi!')

          await checkTraces
        })

        it('instruments a complex langchain chain', async () => {
          stubCall({
            ...openAiBaseChatInfo,
            response: {
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
            }
          })

          const prompt = langchainPrompts.ChatPromptTemplate.fromTemplate(
            'Tell me a short joke about {topic} in the style of {style}'
          )

          const model = new langchainOpenai.ChatOpenAI({ model: 'gpt-4' })

          const parser = new langchainOutputParsers.StringOutputParser()

          const chain = langchainRunnables.RunnableSequence.from([
            {
              topic: new langchainRunnables.RunnablePassthrough(),
              style: new langchainRunnables.RunnablePassthrough()
            },
            prompt,
            model,
            parser
          ])

          const checkTraces = agent
            .assertSomeTraces(traces => {
              const spans = traces[0]
              expect(spans).to.have.length(2)

              const chainSpan = spans[0]
              // we already check the chat model span in previous tests
              expect(spans[1]).to.have.property('resource', 'langchain.chat_models.openai.ChatOpenAI')

              expect(chainSpan.meta).to.have.property('langchain.request.type', 'chain')
              expect(chainSpan.meta).to.have.property('langchain.request.inputs.0.topic', 'chickens')
              expect(chainSpan.meta).to.have.property('langchain.request.inputs.0.style', 'dad joke')
              expect(chainSpan.meta).to.have.property(
                'langchain.response.outputs.0', 'Why did the chicken cross the road? To get to the other side!'
              )
            })

          const result = await chain.invoke({ topic: 'chickens', style: 'dad joke' })

          expect(result).to.equal('Why did the chicken cross the road? To get to the other side!')

          await checkTraces
        })

        it('instruments a batched call', async () => {
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

          const checkTraces = agent
            .assertSomeTraces(traces => {
              const spans = traces[0]
              expect(spans).to.have.length(3) // 1 chain + 2 chat model

              const chainSpan = spans[0]

              expect(chainSpan.meta).to.have.property('langchain.request.type', 'chain')
              expect(chainSpan.meta).to.have.property('langchain.request.inputs.0', 'chickens')
              expect(chainSpan.meta).to.have.property('langchain.request.inputs.1', 'dogs')
              expect(chainSpan.meta).to.have.property(
                'langchain.response.outputs.0', 'Why did the chicken cross the road? To get to the other side!'
              )
              expect(chainSpan.meta).to.have.property(
                'langchain.response.outputs.1', 'Why was the dog confused? It was barking up the wrong tree!'
              )
            })

          const result = await chain.batch(['chickens', 'dogs'])

          expect(result).to.have.length(2)
          expect(result[0]).to.equal('Why did the chicken cross the road? To get to the other side!')
          expect(result[1]).to.equal('Why was the dog confused? It was barking up the wrong tree!')

          await checkTraces
        })

        it('instruments a chain with a JSON output parser and tags it correctly', async function () {
          if (!langchainOutputParsers.JsonOutputParser) this.skip()

          stubCall({
            ...openAiBaseChatInfo,
            response: {
              choices: [{
                message: {
                  role: 'assistant',
                  content: '{\n  "name": "John",\n  "age": 30\n}',
                  refusal: null
                }
              }]
            }
          })

          const checkTraces = agent
            .assertSomeTraces(traces => {
              const spans = traces[0]
              expect(spans).to.have.length(2) // 1 chain + 1 chat model

              const chainSpan = spans[0]

              expect(chainSpan.meta).to.have.property('langchain.request.type', 'chain')
              expect(chainSpan.meta).to.have.property(
                'langchain.request.inputs.0', 'Generate a JSON object with name and age.'
              )

              expect(chainSpan.meta).to.have.property('langchain.response.outputs.0', '{"name":"John","age":30}')
            })

          const parser = new langchainOutputParsers.JsonOutputParser()
          const model = new langchainOpenai.ChatOpenAI({ model: 'gpt-3.5-turbo' })

          const chain = model.pipe(parser)

          const response = await chain.invoke('Generate a JSON object with name and age.')
          expect(response).to.deep.equal({
            name: 'John',
            age: 30
          })

          await checkTraces
        })
      })

      describe('embeddings', () => {
        describe('@langchain/openai', () => {
          it('does not tag output on error', async () => {
            nock('https://api.openai.com').post('/v1/embeddings').reply(403)

            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0].length).to.equal(1)

                const span = traces[0][0]

                expect(span.meta).to.not.have.property('langchain.response.outputs.embedding_length')

                expect(span.meta).to.have.property('error.message')
                expect(span.meta).to.have.property('error.type')
                expect(span.meta).to.have.property('error.stack')
              })

            try {
              const embeddings = new langchainOpenai.OpenAIEmbeddings()
              await embeddings.embedQuery('Hello, world!')
            } catch {}

            await checkTraces
          })

          it('instruments a langchain openai embedQuery call', async () => {
            if (semver.satisfies(langchainOpenaiOpenAiVersion, '>=4.91.0')) {
              stubCall({
                ...openAiBaseEmbeddingInfo,
                response: require('./fixtures/single-embedding.json')
              })
            } else {
              stubCall({
                ...openAiBaseEmbeddingInfo,
                response: {
                  object: 'list',
                  data: [{
                    object: 'embedding',
                    index: 0,
                    embedding: Array(1536).fill(0)
                  }]
                }
              })
            }

            const embeddings = new langchainOpenai.OpenAIEmbeddings()

            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0].length).to.equal(1)
                const span = traces[0][0]

                expect(span).to.have.property('name', 'langchain.request')
                expect(span).to.have.property('resource', 'langchain.embeddings.openai.OpenAIEmbeddings')

                expect(span.meta).to.have.property('langchain.request.api_key', '...key>')
                expect(span.meta).to.have.property('langchain.request.provider', 'openai')
                expect(span.meta).to.have.property('langchain.request.model', 'text-embedding-ada-002')
                expect(span.meta).to.have.property('langchain.request.type', 'embedding')

                expect(span.meta).to.have.property('langchain.request.inputs.0.text', 'Hello, world!')
                expect(span.metrics).to.have.property('langchain.request.input_counts', 1)
                expect(span.metrics).to.have.property('langchain.response.outputs.embedding_length', 1536)
              })

            const query = 'Hello, world!'
            const result = await embeddings.embedQuery(query)

            expect(result).to.have.length(1536)

            await checkTraces
          })

          it('instruments a langchain openai embedDocuments call', async () => {
            if (semver.satisfies(langchainOpenaiOpenAiVersion, '>=4.91.0')) {
              stubCall({
                ...openAiBaseEmbeddingInfo,
                response: require('./fixtures/double-embedding.json')
              })
            } else {
              stubCall({
                ...openAiBaseEmbeddingInfo,
                response: {
                  object: 'list',
                  data: [{
                    object: 'embedding',
                    index: 0,
                    embedding: Array(1536).fill(0)
                  }, {
                    object: 'embedding',
                    index: 1,
                    embedding: Array(1536).fill(0)
                  }]
                }
              })
            }

            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0].length).to.equal(1)
                const span = traces[0][0]

                expect(span.meta).to.have.property('langchain.request.inputs.0.text', 'Hello, world!')
                expect(span.meta).to.have.property('langchain.request.inputs.1.text', 'Goodbye, world!')
                expect(span.metrics).to.have.property('langchain.request.input_counts', 2)

                expect(span.metrics).to.have.property('langchain.response.outputs.embedding_length', 1536)
              })

            const embeddings = new langchainOpenai.OpenAIEmbeddings()

            const documents = ['Hello, world!', 'Goodbye, world!']
            const result = await embeddings.embedDocuments(documents)

            expect(result).to.have.length(2)
            expect(result[0]).to.have.length(1536)
            expect(result[1]).to.have.length(1536)

            await checkTraces
          })
        })

        describe('@langchain/google-genai', () => {
          let response
          let originalFetch

          beforeEach(() => {
            // we don't have a good way to `nock` the requests
            // they utilize `fetch`, so we'll temporarily patch it instead
            originalFetch = global.fetch
            global.fetch = async function () {
              return Promise.resolve(response)
            }
          })

          afterEach(() => {
            global.fetch = originalFetch
          })

          // version compatibility issues on lower versions
          it('instruments a langchain google-genai embedQuery call', async function () {
            if (!langchainGoogleGenAI) this.skip()
            response = {
              json () {
                return {
                  embedding: {
                    values: [-0.0034387498, -0.026400521]
                  }
                }
              },
              ok: true
            }

            const embeddings = new langchainGoogleGenAI.GoogleGenerativeAIEmbeddings({
              model: 'text-embedding-004',
              taskType: 'RETRIEVAL_DOCUMENT',
              title: 'Document title'
            })

            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0].length).to.equal(1)

                const span = traces[0][0]
                expect(span).to.have.property('name', 'langchain.request')
                expect(span).to.have.property('resource', 'langchain.embeddings.GoogleGenerativeAIEmbeddings')

                expect(span.meta).to.have.property('langchain.request.api_key', '...key>')
                expect(span.meta).to.have.property('langchain.request.provider', 'googlegenerativeai')
                expect(span.meta).to.have.property('langchain.request.model', 'text-embedding-004')
                expect(span.meta).to.have.property('langchain.request.type', 'embedding')

                expect(span.meta).to.have.property('langchain.request.inputs.0.text', 'Hello, world!')
                expect(span.metrics).to.have.property('langchain.request.input_counts', 1)
                expect(span.metrics).to.have.property('langchain.response.outputs.embedding_length', 2)
              })

            const query = 'Hello, world!'
            const result = await embeddings.embedQuery(query)
            expect(result).to.have.length(2)
            expect(result).to.deep.equal([-0.0034387498, -0.026400521])

            await checkTraces
          })
        })
      })
    })
  })
})
