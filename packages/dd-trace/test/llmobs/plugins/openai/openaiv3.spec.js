'use strict'

const agent = require('../../../plugins/agent')
const Sampler = require('../../../../src/sampler')
const { DogStatsDClient } = require('../../../../src/dogstatsd')
const { NoopExternalLogger } = require('../../../../src/external-logger/src')
const { withVersions } = require('../../../setup/mocha')

const { expectedLLMObsLLMSpanEvent, deepEqualWithMockValues, MOCK_STRING, MOCK_NUMBER } = require('../../util')
const chai = require('chai')
const semifies = require('semifies')
const LLMObsSpanWriter = require('../../../../src/llmobs/writers/spans')

const { expect } = chai

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

describe('integrations', () => {
  let openai

  describe('openai', () => {
    before(() => {
      sinon.stub(LLMObsSpanWriter.prototype, 'append')

      // reduce errors related to too many listeners
      process.removeAllListeners('beforeExit')

      sinon.stub(DogStatsDClient.prototype, '_add')
      sinon.stub(NoopExternalLogger.prototype, 'log')
      sinon.stub(Sampler.prototype, 'isSampled').returns(true)

      LLMObsSpanWriter.prototype.append.reset()

      return agent.load('openai', {}, {
        llmobs: {
          mlApp: 'test',
          agentlessEnabled: false
        }
      })
    })

    afterEach(() => {
      LLMObsSpanWriter.prototype.append.reset()
    })

    after(() => {
      require('../../../../../dd-trace').llmobs.disable() // unsubscribe from all events
      sinon.restore()
      return agent.close({ ritmReset: false, wipe: true })
    })

    withVersions('openai', 'openai', '<4', version => {
      const moduleRequirePath = `../../../../../../versions/openai@${version}`
      let realVersion

      beforeEach(() => {
        const requiredModule = require(moduleRequirePath)
        const module = requiredModule.get()
        realVersion = requiredModule.version()

        const { Configuration, OpenAIApi } = module

        const configuration = new Configuration({
          apiKey: process.env.OPENAI_API_KEY ?? 'sk-DATADOG-ACCEPTANCE-TESTS',
          basePath: 'http://127.0.0.1:9126/vcr/openai'
        })

        openai = new OpenAIApi(configuration)
      })

      it('submits a completion span', async () => {
        const checkSpan = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          const expected = expectedLLMObsLLMSpanEvent({
            span,
            spanKind: 'llm',
            name: 'OpenAI.createCompletion',
            inputMessages: [
              { content: 'Hello, OpenAI!' }
            ],
            outputMessages: [
              { content: MOCK_STRING }
            ],
            tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
            modelName: 'gpt-3.5-turbo-instruct',
            modelProvider: 'openai',
            metadata: {
              max_tokens: 100,
              temperature: 0.5,
              n: 1,
              stream: false,
            },
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        await openai.createCompletion({
          model: 'gpt-3.5-turbo-instruct',
          prompt: 'Hello, OpenAI!',
          max_tokens: 100,
          temperature: 0.5,
          n: 1,
          stream: false,
        })

        await checkSpan
      })

      it('submits a chat completion span', async function () {
        if (semifies(realVersion, '<3.2.0')) {
          this.skip()
        }

        const checkSpan = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          const expected = expectedLLMObsLLMSpanEvent({
            span,
            spanKind: 'llm',
            name: 'OpenAI.createChatCompletion',
            inputMessages: [
              { role: 'system', content: 'You are a helpful assistant.' },
              { role: 'user', content: 'Hello, OpenAI!' }
            ],
            outputMessages: [
              { role: 'assistant', content: MOCK_STRING }
            ],
            tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
            modelName: 'gpt-3.5-turbo',
            modelProvider: 'openai',
            metadata: {
              max_tokens: 100,
              temperature: 0.5,
              n: 1,
              stream: false,
              user: 'dd-trace-test'
            },
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        await openai.createChatCompletion({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: 'You are a helpful assistant.'
            },
            {
              role: 'user',
              content: 'Hello, OpenAI!'
            }
          ],
          temperature: 0.5,
          stream: false,
          max_tokens: 100,
          n: 1,
          user: 'dd-trace-test'
        })

        await checkSpan
      })

      it('submits an embedding span', async () => {
        const checkSpan = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          const expected = expectedLLMObsLLMSpanEvent({
            span,
            spanKind: 'embedding',
            name: 'OpenAI.createEmbedding',
            inputDocuments: [
              { text: 'hello world' }
            ],
            outputValue: '[1 embedding(s) returned]',
            tokenMetrics: { input_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
            modelName: 'text-embedding-ada-002',
            modelProvider: 'openai',
            metadata: { encoding_format: 'base64' },
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        await openai.createEmbedding({
          model: 'text-embedding-ada-002',
          input: 'hello world',
          encoding_format: 'base64'
        })

        await checkSpan
      })

      it('submits a chat completion span with functions', async function () {
        if (semifies(realVersion, '<3.2.0')) {
          this.skip()
        }

        const checkSpan = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          const expected = expectedLLMObsLLMSpanEvent({
            span,
            spanKind: 'llm',
            name: 'OpenAI.createChatCompletion',
            modelName: 'gpt-3.5-turbo',
            modelProvider: 'openai',
            inputMessages: [{ role: 'user', content: 'What is the weather in New York City?' }],
            outputMessages: [{
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  name: 'get_weather',
                  arguments: {
                    city: 'New York City'
                  },
                  tool_id: MOCK_STRING,
                  type: 'function'
                }
              ]
            }],
            metadata: { function_call: 'auto', stream: false },
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' },
            tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER }
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        await openai.createChatCompletion({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: 'What is the weather in New York City?' }],
          functions: [{
            name: 'get_weather',
            description: 'Get the weather in a given city',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string', description: 'The city to get the weather for' }
              }
            }
          }],
          function_call: 'auto',
          stream: false,
        })

        await checkSpan
      })

      it('submits a completion span with an error', async () => {
        let error
        const checkSpan = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          const expected = expectedLLMObsLLMSpanEvent({
            span,
            spanKind: 'llm',
            name: 'OpenAI.createCompletion',
            inputMessages: [{ content: 'Hello, OpenAI!' }],
            outputMessages: [{ content: '' }],
            modelName: 'gpt-3.5-turbo',
            modelProvider: 'openai',
            metadata: { max_tokens: 100, temperature: 0.5, n: 1, stream: false },
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' },
            error,
            errorType: error.type || error.name,
            errorMessage: error.message,
            errorStack: error.stack
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        try {
          await openai.createCompletion({
            model: 'gpt-3.5-turbo', // incorrect model
            prompt: 'Hello, OpenAI!',
            max_tokens: 100,
            temperature: 0.5,
            n: 1,
            stream: false,
          })
        } catch (e) {
          error = e
        }

        await checkSpan
      })

      it('submits a chat completion span with an error', async function () {
        if (semifies(realVersion, '<3.2.0')) {
          this.skip()
        }

        let error
        const checkSpan = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          const expected = expectedLLMObsLLMSpanEvent({
            span,
            spanKind: 'llm',
            name: 'OpenAI.createChatCompletion',
            inputMessages: [
              { role: 'system', content: 'You are a helpful assistant.' },
              { role: 'user', content: 'Hello, OpenAI!' }
            ],
            outputMessages: [{ content: '' }],
            modelName: 'gpt-3.5-turbo-instruct',
            modelProvider: 'openai',
            metadata: { max_tokens: 100, temperature: 0.5, n: 1, stream: false, user: 'dd-trace-test' },
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' },
            error,
            errorType: error.type || error.name,
            errorMessage: error.message,
            errorStack: error.stack
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        try {
          await openai.createChatCompletion({
            model: 'gpt-3.5-turbo-instruct', // incorrect model
            messages: [
              {
                role: 'system',
                content: 'You are a helpful assistant.'
              },
              {
                role: 'user',
                content: 'Hello, OpenAI!'
              }
            ],
            temperature: 0.5,
            stream: false,
            max_tokens: 100,
            n: 1,
            user: 'dd-trace-test'
          })
        } catch (e) {
          error = e
        }

        await checkSpan
      })
    })
  })
})
