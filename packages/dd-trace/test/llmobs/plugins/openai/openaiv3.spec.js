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

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

const satisfiesChatCompletion = version => semver.intersects('>=3.2.0', version)

describe('integrations', () => {
  let openai
  let mockServerPort

  describe('openai', () => {
    before(async () => {
      sinon.stub(LLMObsSpanWriter.prototype, 'append')

      // reduce errors related to too many listeners
      process.removeAllListeners('beforeExit')

      sinon.stub(DogStatsDClient.prototype, '_add')
      sinon.stub(NoopExternalLogger.prototype, 'log')
      sinon.stub(Sampler.prototype, 'isSampled').returns(true)

      LLMObsSpanWriter.prototype.append.reset()

      mockServerPort = await startMockServer()

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

    after(async () => {
      await stopMockServer()
      require('../../../../../dd-trace').llmobs.disable() // unsubscribe from all events
      sinon.restore()
      return agent.close({ ritmReset: false, wipe: true })
    })

    withVersions('openai', 'openai', '<4', version => {
      const moduleRequirePath = `../../../../../../versions/openai@${version}`

      beforeEach(() => {
        const requiredModule = require(moduleRequirePath)
        const module = requiredModule.get()

        const { Configuration, OpenAIApi } = module

        const configuration = new Configuration({
          apiKey: 'sk-DATADOG-ACCEPTANCE-TESTS',
          basePath: `http://localhost:${mockServerPort}/v1`
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

        await openai.createCompletion({
          model: 'text-davinci-002',
          prompt: 'How are you?'
        })

        await checkSpan
      })

      if (satisfiesChatCompletion(version)) {
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

          await openai.createChatCompletion({
            model: 'gpt-3.5-turbo-0301',
            messages: [
              { role: 'system', content: 'You are a helpful assistant' },
              { role: 'user', content: 'How are you?' }
            ]
          })

          await checkSpan
        })
      }

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

        await openai.createEmbedding({
          model: 'text-embedding-ada-002-v2',
          input: 'Hello, world!'
        })

        await checkSpan
      })

      if (satisfiesChatCompletion(version)) {
        it('submits a chat completion span with functions', async () => {
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
                    }
                  }
                ]
              }],
              metadata: { function_call: 'auto' },
              tags: { ml_app: 'test', language: 'javascript', integration: 'openai' },
              tokenMetrics: { input_tokens: 37, output_tokens: 10, total_tokens: 47 }
            })

            expect(spanEvent).to.deepEqualWithMockValues(expected)
          })

          await openai.createChatCompletion({
            model: 'gpt-3.5-turbo-0301',
            messages: [{ role: 'user', content: 'What is SpongeBob SquarePants\'s origin?' }],
            functions: [{
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
            function_call: 'auto'
          })

          await checkSpan
        })
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
            errorType: error.type || error.name,
            errorMessage: error.message,
            errorStack: error.stack
          })

          expect(spanEvent).to.deepEqualWithMockValues(expected)
        })

        try {
          await openai.createCompletion({
            model: 'gpt-3.5-turbo',
            prompt: 5, // trigger the error
            max_tokens: 50
          })
        } catch (e) {
          error = e
        }

        await checkSpan
      })

      if (satisfiesChatCompletion(version)) {
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
              errorType: error.type || error.name,
              errorMessage: error.message,
              errorStack: error.stack
            })

            expect(spanEvent).to.deepEqualWithMockValues(expected)
          })

          try {
            await openai.createChatCompletion({
              model: 'gpt-3.5-turbo',
              messages: 5, // trigger the error
              max_tokens: 50
            })
          } catch (e) {
            error = e
          }

          await checkSpan
        })
      }
    })
  })
})
