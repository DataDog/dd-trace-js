'use strict'

const LLMObsSpanWriter = require('../../../../src/llmobs/writers/spans')
const agent = require('../../../plugins/agent')
const {
  expectedLLMObsLLMSpanEvent,
  deepEqualWithMockValues
} = require('../../util')
const chai = require('chai')

const fs = require('node:fs')
const path = require('node:path')

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

/**
 * @google-cloud/vertexai uses `fetch` to call against their API, which cannot
 * be stubbed with `nock`. This function allows us to stub the `fetch` function
 * to return a specific response for a given scenario.
 *
 * @param {string} scenario the scenario to load
 * @param {number} statusCode the status code to return. defaults to 200
 */
function useScenario ({ scenario, statusCode = 200, stream = false }) {
  let originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
    global.fetch = function () {
      let body

      if (statusCode !== 200) {
        body = '{}'
      } else if (stream) {
        body = fs.createReadStream(path.join(
          __dirname,
          '../../../../../datadog-plugin-google-cloud-vertexai/test/',
          'resources',
          `${scenario}.txt`)
        )
      } else {
        const contents = require(`../../../../../datadog-plugin-google-cloud-vertexai/test/resources/${scenario}.json`)
        body = JSON.stringify(contents)
      }

      return new Response(body, {
        status: statusCode,
        headers: {
          'Content-Type': 'application/json'
        }
      })
    }
  })

  afterEach(() => {
    global.fetch = originalFetch
  })
}

describe('integrations', () => {
  let authStub
  let model

  function getInputMessages (content) {
    const messages = [
      { role: 'user', content }
    ]

    if (model.systemInstruction) {
      // earlier versions of the SDK do not take a `systemInstruction` property
      messages.unshift({ role: 'system', content: 'Please provide an answer' })
    }

    return messages
  }

  describe('vertexai', () => {
    before(async () => {
      sinon.stub(LLMObsSpanWriter.prototype, 'append')

      // reduce errors related to too many listeners
      process.removeAllListeners('beforeExit')

      return agent.load('google-cloud-vertexai', {}, {
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
      return agent.close({ ritmReset: false, wipe: true })
    })

    withVersions('google-cloud-vertexai', '@google-cloud/vertexai', '>=1', version => {
      before(() => {
        const { VertexAI } = require(`../../../../../../versions/@google-cloud/vertexai@${version}`).get()

        // stub credentials checking
        const { GoogleAuth } = require(`../../../../../../versions/@google-cloud/vertexai@${version}`)
          .get('google-auth-library/build/src/auth/googleauth')
        authStub = sinon.stub(GoogleAuth.prototype, 'getAccessToken').resolves({})

        const client = new VertexAI({
          project: 'datadog-sandbox',
          location: 'us-central1'
        })

        model = client.getGenerativeModel({
          model: 'gemini-1.5-flash-002',
          systemInstruction: 'Please provide an answer',
          generationConfig: {
            maxOutputTokens: 50,
            temperature: 1.0
          }
        })
      })

      after(() => {
        authStub.restore()
      })

      describe('generateContent', () => {
        useScenario({ scenario: 'generate-content-single-response' })

        it('makes a successful call', async () => {
          const checkTraces = agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

            const expected = expectedLLMObsLLMSpanEvent({
              span,
              spanKind: 'llm',
              modelName: 'gemini-1.5-flash-002',
              modelProvider: 'google',
              name: 'GenerativeModel.generateContent',
              inputMessages: getInputMessages('Hello, how are you?'),
              outputMessages: [
                {
                  role: 'model',
                  content: 'Hello! How can I assist you today?'
                }
              ],
              metadata: {
                temperature: 1,
                max_output_tokens: 50
              },
              tokenMetrics: { input_tokens: 35, output_tokens: 2, total_tokens: 37 },
              tags: { ml_app: 'test', language: 'javascript', integration: 'vertexai' }
            })

            expect(spanEvent).to.deepEqualWithMockValues(expected)
          })

          await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: 'Hello, how are you?' }] }]
          })

          await checkTraces
        })
      })

      describe('tool calls', () => {
        useScenario({ scenario: 'generate-content-single-response-with-tools' })

        it('makes a successful call', async () => {
          const checkTraces = agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

            const expected = expectedLLMObsLLMSpanEvent({
              span,
              spanKind: 'llm',
              modelName: 'gemini-1.5-flash-002',
              modelProvider: 'google',
              name: 'GenerativeModel.generateContent',
              inputMessages: getInputMessages('what is 2 + 2?'),
              outputMessages: [
                {
                  role: 'model',
                  content: '',
                  tool_calls: [
                    {
                      name: 'add',
                      arguments: {
                        a: 2,
                        b: 2
                      }
                    }
                  ]
                }
              ],
              metadata: {
                temperature: 1,
                max_output_tokens: 50
              },
              tokenMetrics: { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
              tags: { ml_app: 'test', language: 'javascript', integration: 'vertexai' }
            })

            expect(spanEvent).to.deepEqualWithMockValues(expected)
          })

          await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: 'what is 2 + 2?' }] }]
          })

          await checkTraces
        })
      })

      describe('chat model', () => {
        describe('generateContent', () => {
          useScenario({ scenario: 'generate-content-single-response' })

          it('makes a successful call', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]

              const inputMessages = []

              if (model.systemInstruction) {
                inputMessages.push({ role: 'system', content: 'Please provide an answer' })
              }

              inputMessages.push({ role: 'user', content: 'Foobar?' })
              inputMessages.push({ role: 'model', content: 'Foobar!' })
              inputMessages.push({ content: 'Hello, how are you?' })

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                modelName: 'gemini-1.5-flash-002',
                modelProvider: 'google',
                name: 'ChatSession.sendMessage',
                inputMessages,
                outputMessages: [
                  {
                    role: 'model',
                    content: 'Hello! How can I assist you today?'
                  }
                ],
                metadata: {
                  temperature: 1,
                  max_output_tokens: 50
                },
                tokenMetrics: { input_tokens: 35, output_tokens: 2, total_tokens: 37 },
                tags: { ml_app: 'test', language: 'javascript', integration: 'vertexai' }
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            const chat = model.startChat({
              history: [
                { role: 'user', parts: [{ text: 'Foobar?' }] },
                { role: 'model', parts: [{ text: 'Foobar!' }] }
              ]
            })

            await chat.sendMessage([{ text: 'Hello, how are you?' }])

            await checkTraces
          })
        })
      })
    })
  })
})
