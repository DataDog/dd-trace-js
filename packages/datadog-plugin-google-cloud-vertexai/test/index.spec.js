'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const sinon = require('sinon')
const fs = require('node:fs')
const path = require('node:path')

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
      } if (stream) {
        body = fs.createReadStream(path.join(__dirname, 'resources', `${scenario}.txt`))
      } else {
        const contents = require(`./resources/${scenario}.json`)
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

function promiseState (p) {
  const t = {}
  return Promise.race([p, t])
    .then(v => (v === t) ? 'pending' : 'fulfilled', () => 'rejected')
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
          const checkTraces = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            expect(span).to.have.property('name', 'vertexai.request')
            expect(span).to.have.property('resource', 'GenerativeModel.generateContent')
            expect(span.meta).to.have.property('span.kind', 'client')

            expect(span.meta).to.have.property('vertexai.request.model', 'gemini-1.5-flash-002')
          })

          const { response } = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: 'Hello, how are you?' }] }]
          })
          expect(response).to.have.property('candidates')

          await checkTraces
        })

        it('makes a successful call with a string argument', async () => {
          const checkTraces = agent.assertSomeTraces(traces => {
            expect(traces[0][0].meta).to.have.property('vertexai.request.model', 'gemini-1.5-flash-002')
          })

          const { response } = await model.generateContent('Hello, how are you?')

          expect(response).to.have.property('candidates')

          await checkTraces
        })

        describe('with tools', () => {
          useScenario({ scenario: 'generate-content-single-response-with-tools' })

          it('makes a successful call', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              expect(span.meta).to.have.property('vertexai.request.model', 'gemini-1.5-flash-002')
            })

            await model.generateContent('what is 2 + 2?')

            await checkTraces
          })
        })
      })

      describe('generateContentStream', () => {
        useScenario({ scenario: 'generate-content-stream-single-response', statusCode: 200, stream: true })

        it('makes a successful call', async () => {
          const checkTraces = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            expect(span).to.have.property('name', 'vertexai.request')
            expect(span).to.have.property('resource', 'GenerativeModel.generateContentStream')
            expect(span.meta).to.have.property('span.kind', 'client')

            expect(span.meta).to.have.property('vertexai.request.model', 'gemini-1.5-flash-002')
          })

          const { stream, response } = await model.generateContentStream('Hello, how are you?')

          // check that response is a promise
          expect(response).to.be.a('promise')

          const promState = await promiseState(response)
          expect(promState).to.equal('pending') // we shouldn't have consumed the promise

          for await (const chunk of stream) {
            expect(chunk).to.have.property('candidates')
          }

          const result = await response
          expect(result).to.have.property('candidates')

          await checkTraces
        })
      })

      describe('chatSession', () => {
        describe('sendMessage', () => {
          useScenario({ scenario: 'generate-content-single-response' })

          it('makes a successful call', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              expect(span).to.have.property('name', 'vertexai.request')
              expect(span).to.have.property('resource', 'ChatSession.sendMessage')
              expect(span.meta).to.have.property('span.kind', 'client')

              expect(span.meta).to.have.property('vertexai.request.model', 'gemini-1.5-flash-002')
            })

            const chat = model.startChat({
              history: [
                { role: 'user', parts: [{ text: 'Foobar?' }] },
                { role: 'model', parts: [{ text: 'Foobar!' }] }
              ]
            })
            const { response } = await chat.sendMessage([{ text: 'Hello, how are you?' }])

            expect(response).to.have.property('candidates')

            await checkTraces
          })

          it('tags a string input', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              expect(traces[0][0].meta).to.have.property('vertexai.request.model', 'gemini-1.5-flash-002')
            })

            const chat = model.startChat({})
            const { response } = await chat.sendMessage('Hello, how are you?')

            expect(response).to.have.property('candidates')

            await checkTraces
          })

          it('tags an array of string inputs', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              expect(traces[0][0].meta).to.have.property('vertexai.request.model', 'gemini-1.5-flash-002')
            })

            const chat = model.startChat({})
            const { response } = await chat.sendMessage(['Hello, how are you?', 'What should I do today?'])

            expect(response).to.have.property('candidates')

            await checkTraces
          })
        })

        describe('sendMessageStream', () => {
          useScenario({ scenario: 'generate-content-stream-single-response', statusCode: 200, stream: true })

          it('makes a successful call', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              expect(span).to.have.property('name', 'vertexai.request')
              expect(span).to.have.property('resource', 'ChatSession.sendMessageStream')
              expect(span.meta).to.have.property('span.kind', 'client')

              expect(span.meta).to.have.property('vertexai.request.model', 'gemini-1.5-flash-002')
            })

            const chat = model.startChat({})
            const { stream, response } = await chat.sendMessageStream('Hello, how are you?')

            // check that response is a promise
            expect(response).to.be.a('promise')

            const promState = await promiseState(response)
            expect(promState).to.equal('pending') // we shouldn't have consumed the promise

            for await (const chunk of stream) {
              expect(chunk).to.have.property('candidates')
            }

            const result = await response
            expect(result).to.have.property('candidates')

            await checkTraces
          })
        })
      })

      describe('errors', () => {
        describe('non-streamed', () => {
          useScenario({ statusCode: 404 })

          it('tags the error', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
            })

            let errorPropagated = false

            try {
              await model.generateContent('Hello, how are you?')
            } catch { errorPropagated = true }

            expect(errorPropagated).to.be.true

            await checkTraces
          })
        })

        describe('streamed', () => {
          useScenario({ scenario: 'malformed-stream', stream: true })

          it('tags the error', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
            })

            let errorPropagated = false

            try {
              const { stream } = await model.generateContentStream('Hello, how are you?')
              // eslint-disable-next-line no-unused-vars
              for await (const _ of stream) { /* pass */ }
            } catch { errorPropagated = true }

            expect(errorPropagated).to.be.true

            await checkTraces
          })
        })
      })
    })
  })
})
