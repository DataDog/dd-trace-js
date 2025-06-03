'use strict'

const agent = require('../../../plugins/agent')
const Sampler = require('../../../../src/sampler')
const { DogStatsDClient } = require('../../../../src/dogstatsd')
const { NoopExternalLogger } = require('../../../../src/external-logger/src')

const { expectedLLMObsLLMSpanEvent, deepEqualWithMockValues } = require('../../util')
const chai = require('chai')
const semver = require('semver')
const LLMObsSpanWriter = require('../../../../src/llmobs/writers/spans')
const { startMockServer, stopMockServer } = require('../../../../../datadog-plugin-openai/test/mock-server')

const { expect } = chai

const { NODE_MAJOR } = require('../../../../../../version')

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

const satisfiesTools = version => semver.intersects('>4.16.0', version)
const satisfiesStream = version => semver.intersects('>4.1.0', version)

describe('integrations', () => {
  let openai
  let azureOpenai
  let deepseekOpenai
  let customOpenai

  let realVersion
  let mockServerPort
  let globalFile

  describe('openai', () => {
    before(async () => {
      mockServerPort = await startMockServer()

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
      stopMockServer()

      if (semver.satisfies(realVersion, '>=5.0.0') && NODE_MAJOR < 20) {
        global.File = globalFile
      }

      sinon.restore()
      require('../../../../../dd-trace').llmobs.disable() // unsubscribe from all events
      return agent.close({ ritmReset: false, wipe: true })
    })

    // TODO: Remove the range cap once we support openai 5
    withVersions('openai', 'openai', '>=4 <5', version => {
      const moduleRequirePath = `../../../../../../versions/openai@${version}`

      beforeEach(() => {
        const requiredModule = require(moduleRequirePath)
        const module = requiredModule.get()
        realVersion = requiredModule.version()

        if (semver.satisfies(realVersion, '>=5.0.0') && NODE_MAJOR < 20) {
          /**
           * resolves the following error for OpenAI v5
           *
           * Error: `File` is not defined as a global, which is required for file uploads.
           * Update to Node 20 LTS or newer, or set `globalThis.File` to `import('node:buffer').File`.
           */
          globalFile = global.File
          global.File = require('node:buffer').File
        }

        const OpenAI = module

        customOpenai = new OpenAI({
          apiKey: 'test',
          baseURL: `http://localhost:${mockServerPort}/v1`
        })

        openai = new OpenAI({
          apiKey: 'test'
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
          baseURL: 'https://api.deepseek.com/',
          apiKey: 'test'
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
              { content: 'How are you?' }
            ],
            outputMessages: [
              { content: '\n\nHello, world!' }
            ],
            tokenMetrics: { input_tokens: 3, output_tokens: 16, total_tokens: 19 },
            modelName: 'text-davinci-002',
            modelProvider: 'openai',
            metadata: {},
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        await customOpenai.completions.create({
          model: 'text-davinci-002',
          prompt: 'How are you?'
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
              { role: 'system', content: 'You are a helpful assistant' },
              { role: 'user', content: 'How are you?' }
            ],
            outputMessages: [
              { role: 'assistant', content: 'Hello, world!' }
            ],
            tokenMetrics: { input_tokens: 37, output_tokens: 10, total_tokens: 47 },
            modelName: 'gpt-3.5-turbo-0301',
            modelProvider: 'openai',
            metadata: {},
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        await customOpenai.chat.completions.create({
          model: 'gpt-3.5-turbo-0301',
          messages: [
            { role: 'system', content: 'You are a helpful assistant' },
            { role: 'user', content: 'How are you?' }
          ]
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
              { text: 'Hello, world!' }
            ],
            outputValue: '[1 embedding(s) returned with size 1536]',
            tokenMetrics: { input_tokens: 2, total_tokens: 2 },
            modelName: 'text-embedding-ada-002-v2',
            modelProvider: 'openai',
            metadata: { encoding_format: 'float' },
            tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        await customOpenai.embeddings.create({
          model: 'text-embedding-ada-002-v2',
          input: 'Hello, world!',
          encoding_format: 'float'
        })

        await checkSpan
      })

      if (satisfiesTools(version)) {
        it('submits a chat completion span with tools', async () => {
          const checkSpan = agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

            const expected = expectedLLMObsLLMSpanEvent({
              span,
              spanKind: 'llm',
              name: 'OpenAI.createChatCompletion',
              modelName: 'gpt-3.5-turbo-0301',
              modelProvider: 'openai',
              inputMessages: [{ role: 'user', content: 'What is SpongeBob SquarePants\'s origin?' }],
              outputMessages: [{
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    name: 'extract_fictional_info',
                    arguments: {
                      name: 'some-value',
                      origin: 'some-value'
                    },
                    tool_id: 'tool-1',
                    type: 'function'
                  }
                ]
              }],
              metadata: { tool_choice: 'auto' },
              tags: { ml_app: 'test', language: 'javascript', integration: 'openai' },
              tokenMetrics: { input_tokens: 37, output_tokens: 10, total_tokens: 47 }
            })

            expect(spanEvent).to.deepEqualWithMockValues(expected)
          })

          await customOpenai.chat.completions.create({
            model: 'gpt-3.5-turbo-0301',
            messages: [{ role: 'user', content: 'What is SpongeBob SquarePants\'s origin?' }],
            tools: [{
              type: 'function',
              function: {
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
            }],
            tool_choice: 'auto'
          })

          await checkSpan
        })
      }

      if (satisfiesStream(version)) {
        it('submits a streamed completion span', async () => {
          const checkSpan = agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

            const expected = expectedLLMObsLLMSpanEvent({
              span,
              spanKind: 'llm',
              name: 'OpenAI.createCompletion',
              inputMessages: [
                { content: 'Can you say this is a test?' }
              ],
              outputMessages: [
                { content: ' this is a test.' }
              ],
              tokenMetrics: { input_tokens: 8, output_tokens: 5, total_tokens: 13 },
              modelName: 'text-davinci-002',
              modelProvider: 'openai',
              metadata: { temperature: 0.5, stream: true },
              tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
            })

            expect(spanEvent).to.deepEqualWithMockValues(expected)
          })

          const stream = await customOpenai.completions.create({
            model: 'text-davinci-002',
            prompt: 'Can you say this is a test?',
            temperature: 0.5,
            stream: true
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
                { role: 'user', content: 'Hello' }
              ],
              outputMessages: [
                { role: 'assistant', content: 'Hello! How can I assist you today?' }
              ],
              tokenMetrics: { input_tokens: 1, output_tokens: 9, total_tokens: 10 },
              modelName: 'gpt-3.5-turbo-0301',
              modelProvider: 'openai',
              metadata: { stream: true },
              tags: { ml_app: 'test', language: 'javascript', integration: 'openai' }
            })

            expect(spanEvent).to.deepEqualWithMockValues(expected)
          })

          const stream = await customOpenai.chat.completions.create({
            model: 'gpt-3.5-turbo-0301',
            messages: [{ role: 'user', content: 'Hello' }],
            stream: true
          })

          for await (const part of stream) {
            expect(part).to.have.property('choices')
            expect(part.choices[0]).to.have.property('delta')
          }

          await checkSpan
        })

        if (satisfiesTools(version)) {
          it('submits a chat completion span with tools stream', async () => {
            const checkSpan = agent.assertSomeTraces(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                name: 'OpenAI.createChatCompletion',
                modelName: 'gpt-3.5-turbo-0301',
                modelProvider: 'openai',
                inputMessages: [{ role: 'user', content: 'What function would you call to finish this?' }],
                outputMessages: [{
                  role: 'assistant',
                  content: 'THOUGHT: Hi',
                  tool_calls: [
                    {
                      name: 'finish',
                      arguments: { answer: '5' },
                      type: 'function',
                      tool_id: 'call_Tg0o5wgoNSKF2iggAPmfWwem'
                    }
                  ]
                }],
                metadata: { tool_choice: 'auto', stream: true },
                tags: { ml_app: 'test', language: 'javascript', integration: 'openai' },
                tokenMetrics: { input_tokens: 9, output_tokens: 5, total_tokens: 14 }
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            const stream = await customOpenai.chat.completions.create({
              model: 'gpt-3.5-turbo-0301',
              messages: [{ role: 'user', content: 'What function would you call to finish this?' }],
              tools: [], // empty to trigger the correct scenario
              tool_choice: 'auto',
              stream: true
            })

            for await (const part of stream) {
              expect(part).to.have.property('choices')
              expect(part.choices[0]).to.have.property('delta')
            }

            await checkSpan
          })
        }
      }

      it('submits a completion span with an error', async () => {
        let error
        const checkSpan = agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          const expected = expectedLLMObsLLMSpanEvent({
            span,
            spanKind: 'llm',
            name: 'OpenAI.createCompletion',
            inputMessages: [{ content: 'Hello' }],
            outputMessages: [{ content: '' }],
            modelName: 'gpt-3.5-turbo',
            modelProvider: 'openai',
            metadata: { max_tokens: 50 },
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
            model: 'gpt-3.5-turbo',
            prompt: 5, // trigger the error
            max_tokens: 50
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
            inputMessages: [{ role: 'user', content: 'Hello' }],
            outputMessages: [{ content: '' }],
            modelName: 'gpt-3.5-turbo',
            modelProvider: 'openai',
            metadata: { max_tokens: 50 },
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
            model: 'gpt-3.5-turbo',
            messages: 5, // trigger the error
            max_tokens: 50
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
            model: 'some-model',
            messages: []
          })
        } catch (e) {
          // we expect an error here
        }

        await checkSpan
      })

      it('submits an DeepSeek completion', async () => {
        const checkSpan = agent.assertSomeTraces(traces => {
          const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

          expect(spanEvent).to.have.property('name', 'DeepSeek.createChatCompletion')
          expect(spanEvent.meta).to.have.property('model_provider', 'deepseek')
        })

        try {
          await deepseekOpenai.chat.completions.create({
            model: 'some-model',
            messages: []
          })
        } catch (e) {
          // we expect an error here
        }

        await checkSpan
      })
    })
  })
})
