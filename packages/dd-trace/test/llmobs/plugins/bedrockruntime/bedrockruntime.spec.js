'use strict'

const agent = require('../../../plugins/agent')
const Sampler = require('../../../../src/sampler')
const { DogStatsDClient } = require('../../../../src/dogstatsd')
const { NoopExternalLogger } = require('../../../../src/external-logger/src')

const nock = require('nock')
const { expectedLLMObsLLMSpanEvent, deepEqualWithMockValues, MOCK_ANY } = require('../../util')
const chai = require('chai')
const LLMObsAgentProxySpanWriter = require('../../../../src/llmobs/writers/spans/agentProxy')

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

const serviceName = 'bedrock-service-name-test'

const PROVIDER = {
  AI21: 'AI21',
  AMAZON: 'AMAZON',
  ANTHROPIC: 'ANTHROPIC',
  COHERE: 'COHERE',
  META: 'META',
  MISTRAL: 'MISTRAL'
}

describe('Plugin', () => {
  describe('aws-sdk (bedrockruntime)', function () {
    before(() => {
      process.env.AWS_SECRET_ACCESS_KEY = '0000000000/00000000000000000000000000000'
      process.env.AWS_ACCESS_KEY_ID = '00000000000000000000'
    })

    after(() => {
      delete process.env.AWS_SECRET_ACCESS_KEY
      delete process.env.AWS_ACCESS_KEY_ID
    })

    withVersions('aws-sdk', ['@aws-sdk/smithy-client', 'aws-sdk'], '>=3', (version, moduleName) => {
      let AWS
      let bedrockRuntimeClient

      const bedrockRuntimeClientName =
        moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-bedrock-runtime' : 'aws-sdk'

      describe('with configuration', () => {
        before(() => {
          sinon.stub(LLMObsAgentProxySpanWriter.prototype, 'append')

          // reduce errors related to too many listeners
          process.removeAllListeners('beforeExit')


          LLMObsAgentProxySpanWriter.prototype.append.reset()

          return agent.load('aws-sdk', {}, {
            llmobs: {
              mlApp: 'test'
            }
          })
        })

        before(done => {
          const requireVersion = version === '3.0.0' ? '3.422.0' : '>=3.422.0'
          AWS = require(`../../../../../../versions/${bedrockRuntimeClientName}@${requireVersion}`).get()
          bedrockRuntimeClient = new AWS.BedrockRuntimeClient(
            { endpoint: 'http://127.0.0.1:4566', region: 'us-east-1', ServiceId: serviceName }
          )
          done()
        })

        afterEach(() => {
          nock.cleanAll()
          LLMObsAgentProxySpanWriter.prototype.append.reset()
        })

        after(() => {
          sinon.restore()
          return agent.close({ ritmReset: false, wipe: true })
        })

        const prompt = 'What is the capital of France?'
        const temperature = 0.5
        const topP = 1
        const topK = 1
        const maxTokens = 512

        const models = [
          {
            provider: PROVIDER.AMAZON,
            modelId: 'amazon.titan-text-lite-v1',
            userPrompt: prompt,
            requestBody: {
              inputText: prompt,
              textGenerationConfig: {
                temperature,
                topP,
                maxTokenCount: maxTokens
              }
            },
            response: {
              inputTextTokenCount: 7,
              results: {
                inputTextTokenCount: 7,
                results: [
                  {
                    tokenCount: 35,
                    outputText: '\n' +
                      'Paris is the capital of France. France is a country that is located in Western Europe. ' +
                      'Paris is one of the most populous cities in the European Union. ',
                    completionReason: 'FINISH'
                  }
                ]
              }
            }
          },
          {
            provider: PROVIDER.AI21,
            modelId: 'ai21.jamba-1-5-mini-v1',
            userPrompt: prompt,
            requestBody: {
              messages: [
                {
                  role: 'user',
                  content: prompt
                }
              ],
              max_tokens: maxTokens,
              temperature,
              top_p: topP,
              top_k: topK
            },
            response: {
              id: 'req_0987654321',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: 'The capital of France is Paris.'
                  },
                  finish_reason: 'stop'
                }
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 7,
                total_tokens: 17
              }
            }
          },
          {
            provider: PROVIDER.ANTHROPIC,
            modelId: 'anthropic.claude-v2',
            userPrompt: `\n\nHuman:${prompt}\n\nAssistant:`,
            requestBody: {
              prompt: `\n\nHuman:${prompt}\n\nAssistant:`,
              temperature,
              top_p: topP,
              top_k: topK,
              max_tokens_to_sample: maxTokens
            },
            response: {
              type: 'completion',
              completion: ' Paris is the capital of France.',
              stop_reason: 'stop_sequence',
              stop: '\n\nHuman:'
            }
          },
          {
            provider: PROVIDER.COHERE,
            modelId: 'cohere.command-light-text-v14',
            userPrompt: prompt,
            requestBody: {
              prompt,
              temperature,
              p: topP,
              k: topK,
              max_tokens: maxTokens
            },
            response: {
              id: '91c65da4-e2cd-4930-a4a9-f5c68c8a137c',
              generations: [
                {
                  id: 'c040d384-ad9c-4d15-8c2f-f36fbfb0eb55',
                  text: ' The capital of France is Paris. \n',
                  finish_reason: 'COMPLETE'
                }
              ],
              prompt: 'What is the capital of France?'
            }

          },
          {
            provider: PROVIDER.META,
            modelId: 'meta.llama3-70b-instruct-v1',
            userPrompt: prompt,
            requestBody: {
              prompt,
              temperature,
              top_p: topP,
              max_gen_len: maxTokens
            },
            response: {
              generation: '\n\nThe capital of France is Paris.',
              prompt_token_count: 10,
              generation_token_count: 7,
              stop_reason: 'stop'
            }
          },
          {
            provider: PROVIDER.MISTRAL,
            modelId: 'mistral.mistral-7b-instruct-v0',
            userPrompt: prompt,
            requestBody: {
              prompt,
              max_tokens: maxTokens,
              temperature,
              top_p: topP,
              top_k: topK
            },
            response: {
              outputs: [
                {
                  text: 'The capital of France is Paris.',
                  stop_reason: 'stop'
                }
              ]
            }
          }
        ]

        models.forEach(model => {
          it(`should invoke model for provider:${model.provider}`, done => {
            const request = {
              body: JSON.stringify(model.requestBody),
              contentType: 'application/json',
              accept: 'application/json',
              modelId: model.modelId
            }

            const response = JSON.stringify(model.response)

            nock('http://127.0.0.1:4566')
              .post(`/model/${model.modelId}/invoke`)
              .reply(200, response)

            const command = new AWS.InvokeModelCommand(request)

            agent.use(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]
              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                name: 'bedrock-runtime.invokeModel',
                inputMessages: [
                  { content: model.userPrompt }
                ],
                outputMessages: MOCK_ANY,
                tokenMetrics: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                modelName: model.modelId.split('.')[1].toLowerCase(),
                modelProvider: model.provider.toLowerCase(),
                metadata: {
                  temperature,
                  max_tokens: maxTokens
                },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            }).then(done).catch(done)

            bedrockRuntimeClient.send(command, (err) => {
              if (err) return done(err)
            })
          })
        })
      })
    })
  })
})
