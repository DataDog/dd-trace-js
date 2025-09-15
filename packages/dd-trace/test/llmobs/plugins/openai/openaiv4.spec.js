'use strict'

const chai = require('chai')
const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const semifies = require('semifies')
const sinon = require('sinon')

const agent = require('../../../plugins/agent')
const Sampler = require('../../../../src/sampler')
const { DogStatsDClient } = require('../../../../src/dogstatsd')
const { NoopExternalLogger } = require('../../../../src/external-logger/src')
const { withVersions } = require('../../../setup/mocha')

const { expectedLLMObsLLMSpanEvent, deepEqualWithMockValues, MOCK_STRING, MOCK_NUMBER } = require('../../util')
const LLMObsSpanWriter = require('../../../../src/llmobs/writers/spans')

const { expect } = chai

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

describe('integrations', () => {
  let openai
  let azureOpenai
  let deepseekOpenai

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
      sinon.restore()
      require('../../../../../dd-trace').llmobs.disable() // unsubscribe from all events
      // delete require.cache[require.resolve('../../../../dd-trace')]
      return agent.close({ ritmReset: false, wipe: true })
    })

    // TODO: Remove the range cap once we support openai 5
    withVersions('openai', 'openai', '>=4 <5', version => {
      const moduleRequirePath = `../../../../../../versions/openai@${version}`
      let realVersion

      beforeEach(() => {
        const requiredModule = require(moduleRequirePath)
        const module = requiredModule.get()
        realVersion = requiredModule.version()

        const OpenAI = module

        openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY ?? 'test',
          baseURL: 'http://127.0.0.1:9126/vcr/openai'
        })

        const AzureOpenAI = OpenAI.AzureOpenAI ?? OpenAI
        if (OpenAI.AzureOpenAI) {
          azureOpenai = new AzureOpenAI({
            endpoint: 'https://dd.openai.azure.com/',
            apiKey: 'test',
            apiVersion: '2024-05-01-preview'
          })
        } else {
          azureOpenai = new OpenAI({
            baseURL: 'https://dd.openai.azure.com/',
            apiKey: 'test',
            apiVersion: '2024-05-01-preview'
          })
        }

        deepseekOpenai = new OpenAI({
          baseURL: 'http://127.0.0.1:9126/vcr/deepseek',
          apiKey: process.env.DEEPSEEK_API_KEY ?? 'test'
        })
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

        await openai.completions.create({
          model: 'gpt-3.5-turbo-instruct',
          prompt: 'Hello, OpenAI!',
          max_tokens: 100,
          temperature: 0.5,
          n: 1,
          stream: false,
        })

        await checkSpan
      })

      it('submits a chat completion span', async () => {
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

        await openai.chat.completions.create({
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

        await openai.embeddings.create({
          model: 'text-embedding-ada-002',
          input: 'hello world',
          encoding_format: 'base64'
        })

        await checkSpan
      })

      it('submits a chat completion span with tools', async function () {
        if (semifies(realVersion, '<=4.16.0')) {
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
            metadata: { tool_choice: 'auto', stream: false },
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' },
            tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER }
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: 'What is the weather in New York City?' }],
          tools: [{
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get the weather in a given city',
              parameters: {
                type: 'object',
                properties: {
                  city: { type: 'string', description: 'The city to get the weather for' }
                }
              }
            }
          }],
          tool_choice: 'auto',
          stream: false,
        })

        await checkSpan
      })

      describe('stream', function () {
        beforeEach(function () {
          if (semifies(realVersion, '<=4.1.0')) {
            this.skip()
          }
        })

        it('submits a streamed completion span', async () => {
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
                { content: '\n\nHello! How can I assist you?' }
              ],
              tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
              modelName: 'gpt-3.5-turbo-instruct',
              modelProvider: 'openai',
              metadata: { max_tokens: 100, temperature: 0.5, n: 1, stream: true },
              tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
            })

            expect(spanEvent).to.deepEqualWithMockValues(expected)
          })

          const stream = await openai.completions.create({
            model: 'gpt-3.5-turbo-instruct',
            prompt: 'Hello, OpenAI!',
            max_tokens: 100,
            temperature: 0.5,
            n: 1,
            stream: true,
          })

          for await (const part of stream) {
            expect(part).to.have.property('choices')
            expect(part.choices[0]).to.have.property('text')
          }

          await checkSpan
        })

        it('submits a streamed chat completion span', async () => {
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
                { role: 'assistant', content: 'Hello! How can I assist you today?' }
              ],
              tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
              modelName: 'gpt-3.5-turbo',
              modelProvider: 'openai',
              metadata: { max_tokens: 100, temperature: 0.5, n: 1, stream: true, user: 'dd-trace-test' },
              tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
            })

            expect(spanEvent).to.deepEqualWithMockValues(expected)
          })

          const stream = await openai.chat.completions.create({
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
            stream: true,
            max_tokens: 100,
            n: 1,
            user: 'dd-trace-test'
          })

          for await (const part of stream) {
            expect(part).to.have.property('choices')
            expect(part.choices[0]).to.have.property('delta')
          }

          await checkSpan
        })

        it('submits a chat completion span with tools stream', async function () {
          if (semifies(realVersion, '<=4.16.0')) {
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
                    arguments: { city: 'New York City' },
                    type: 'function',
                    tool_id: MOCK_STRING
                  }
                ]
              }],
              metadata: { tool_choice: 'auto', stream: true },
              tags: { ml_app: 'test', language: 'javascript', integration: 'openai' },
              tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER }
            })

            expect(spanEvent).to.deepEqualWithMockValues(expected)
          })

          const stream = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: 'What is the weather in New York City?' }],
            tools: [{
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get the weather in a given city',
                parameters: {
                  type: 'object',
                  properties: {
                    city: { type: 'string', description: 'The city to get the weather for' }
                  }
                }
              }
            }],
            tool_choice: 'auto',
            stream: true,
          })

          for await (const part of stream) {
            expect(part).to.have.property('choices')
            expect(part.choices[0]).to.have.property('delta')
          }

          await checkSpan
        })
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
            errorType: 'Error',
            errorMessage: error.message,
            errorStack: error.stack
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        try {
          await openai.completions.create({
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

      it('submits a chat completion span with an error', async () => {
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
            errorType: 'Error',
            errorMessage: error.message,
            errorStack: error.stack
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        try {
          await openai.chat.completions.create({
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

      it('submits an AzureOpenAI completion', async () => {
        const checkSpan = agent.assertSomeTraces(traces => {
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          expect(spanEvent).to.have.property('name', 'AzureOpenAI.createChatCompletion')
          expect(spanEvent.meta).to.have.property('model_provider', 'azure_openai')
        })

        try {
          await azureOpenai.chat.completions.create({
            model: 'gpt-4.1',
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
          // expected error
        }

        await checkSpan
      })

      it('submits an DeepSeek completion', async () => {
        const checkSpan = agent.assertSomeTraces(() => {
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          expect(spanEvent).to.have.property('name', 'DeepSeek.createChatCompletion')
          expect(spanEvent.meta).to.have.property('model_provider', 'deepseek')
        })

        await deepseekOpenai.chat.completions.create({
          model: 'deepseek-chat',
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

      it('submits a chat completion span with cached token metrics', async () => {
        const baseMessages = [{"role": "system", "content": "You are an expert software engineer ".repeat(200)}];

        await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: baseMessages.concat([{"role": "user", "content": "What are the best practices for API design?"}]),
          temperature: 0.5,
          stream: false,
          max_tokens: 100,
          n: 1,
          user: 'dd-trace-test'
        })

        const checkSpan = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(1).args[0]

          const expected = expectedLLMObsLLMSpanEvent({
            span,
            spanKind: 'llm',
            name: 'OpenAI.createChatCompletion',
            inputMessages: baseMessages.concat([{"role": "user", "content": "How should I structure my database schema?"}]),
            outputMessages: [
              { role: 'assistant', content: MOCK_STRING }
            ],
            tokenMetrics: {
              input_tokens: 1220,
              output_tokens: 100,
              total_tokens: 1320,
              cache_read_input_tokens: 1152,
            },
            modelName: 'gpt-4o',
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

        await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: baseMessages.concat([{"role": "user", "content": "How should I structure my database schema?"}]),
          temperature: 0.5,
          stream: false,
          max_tokens: 100,
          n: 1,
          user: 'dd-trace-test'
        })

        await checkSpan
      })
    })
  })
})
