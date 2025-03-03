'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const sinon = require('sinon')

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
      const contents = require(`./resources/${scenario}.json`)
      let body = JSON.stringify(contents)

      if (stream) {
        body = new ReadableStream({
          start (controller) {
            controller.enqueue(new TextEncoder().encode(body))
            controller.close()
          }
        })
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

describe('Plugin', () => {
  describe('google-cloud-vertexai', () => {
    let model
    let authStub

    withVersions('google-cloud-vertexai', '@google-cloud/vertexai', '>=1', version => {
      before(() => {
        return agent.load('google-cloud-vertexai')
      })

      before(() => {
        const { VertexAI } = require(`../../../versions/@google-cloud/vertexai@${version}`).get()

        // stub credentials checking
        const { GoogleAuth } = require(`../../../versions/@google-cloud/vertexai@${version}`)
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
        return agent.close({ ritmReset: false })
      })

      describe('generateContent', () => {
        useScenario({ scenario: 'generate-content-single-response' })

        it('makes a successful call', async () => {
          const checkTraces = agent.use(traces => {
            const span = traces[0][0]

            expect(span).to.have.property('name', 'vertexai.request')
            expect(span).to.have.property('resource', 'GenerativeModel.generateContent')
            expect(span.meta).to.have.property('span.kind', 'client')

            expect(span.meta).to.have.property('vertexai.request.model', 'gemini-1.5-flash-002')
            expect(span.meta).to.have.property('vertexai.request.contents.0.role', 'user')
            expect(span.meta).to.have.property('vertexai.request.contents.0.parts.0.text', 'Hello, how are you?')
            expect(span.meta).to.have.property('vertexai.response.candidates.0.finish_reason', 'STOP')
            expect(span.meta).to.have.property('vertexai.response.candidates.0.content.parts.0.text',
              'Hello! How can I assist you today?')
            expect(span.meta).to.have.property('vertexai.response.candidates.0.content.role', 'model')

            expect(span.metrics).to.have.property('vertexai.response.usage.prompt_tokens', 35)
            expect(span.metrics).to.have.property('vertexai.response.usage.completion_tokens', 2)
            expect(span.metrics).to.have.property('vertexai.response.usage.total_tokens', 37)

            if (model.systemInstruction) {
              expect(span.meta).to.have.property('vertexai.request.system_instruction.0.text',
                'Please provide an answer')
            }
            expect(span.meta).to.have.property('vertexai.request.generation_config.max_output_tokens', '50')
            expect(span.meta).to.have.property('vertexai.request.generation_config.temperature', '1')
          })

          const { response } = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: 'Hello, how are you?' }] }]
          })

          expect(response).to.have.property('candidates')

          await checkTraces
        })

        it('makes a successful call with a string argument', async () => {
          const checkTraces = agent.use(traces => {
            expect(traces[0][0].meta).to.have.property('vertexai.request.contents.0.text',
              'Hello, how are you?')
          })

          const { response } = await model.generateContent('Hello, how are you?')

          expect(response).to.have.property('candidates')

          await checkTraces
        })
      })

      describe.skip('generateContentStream', () => {
        useScenario({ scenario: 'generate-content-single-response', statusCode: 200, stream: true })

        it('makes a successful call', async () => {
          const { stream } = await model.generateContentStream('Hello, how are you?')
          for await (const chunk of stream) {
            console.log(chunk)
          }
        })
      })

      describe('chatSession', () => {
        describe('generateContent', () => {
          useScenario({ scenario: 'generate-content-single-response' })

          it.skip('makes a successful call', async () => {
            const checkTraces = agent.use(traces => {
              const span = traces[0][0]

              expect(span).to.have.property('name', 'vertexai.request')
              expect(span).to.have.property('resource', 'ChatSession.sendMessage')
              expect(span.meta).to.have.property('span.kind', 'client')

              expect(span.meta).to.have.property('vertexai.request.model', 'gemini-1.5-flash-002')
              expect(span.meta).to.have.property('vertexai.request.contents.0.role', 'user')
              expect(span.meta).to.have.property('vertexai.request.contents.0.parts.0.text', 'Hello, how are you?')
              expect(span.meta).to.have.property('vertexai.response.candidates.0.finish_reason', 'STOP')
              expect(span.meta).to.have.property('vertexai.response.candidates.0.content.parts.0.text',
                'Hello! How can I assist you today?')
              expect(span.meta).to.have.property('vertexai.response.candidates.0.content.role', 'model')

              expect(span.metrics).to.have.property('vertexai.response.usage.prompt_tokens', 35)
              expect(span.metrics).to.have.property('vertexai.response.usage.completion_tokens', 2)
              expect(span.metrics).to.have.property('vertexai.response.usage.total_tokens', 37)

              if (model.systemInstruction) {
                expect(span.meta).to.have.property('vertexai.request.system_instruction.0.text',
                  'Please provide an answer')
              }
              expect(span.meta).to.have.property('vertexai.request.generation_config.max_output_tokens', '50')
              expect(span.meta).to.have.property('vertexai.request.generation_config.temperature', '1')
            })

            // add some history?
            const chat = model.startChat({ history: [] })
            const { response } = await chat.sendMessage({
              contents: [{ role: 'user', parts: [{ text: 'Hello, how are you?' }] }]
            })

            expect(response).to.have.property('candidates')

            await checkTraces
          })
        })

        describe('generateContentStream', () => {})
      })

      describe('errors', () => {
        useScenario({ scenario: 'generate-content-error', statusCode: 404 })

        it('tags the error', async () => {
          const checkTraces = agent.use(traces => {
            expect(traces[0][0]).to.have.property('error', 1)
          })

          try {
            await model.generateContent('Hello, how are you?')
          } catch { /* ignore */ }

          await checkTraces
        })
      })
    })
  })
})
