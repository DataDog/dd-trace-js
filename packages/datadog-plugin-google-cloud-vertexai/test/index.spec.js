'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
/**
 * `@google-cloud/vertexai` uses `fetch` to call against their API, which cannot
 * be stubbed with `nock`. This function allows us to stub the `fetch` function
 * to return a specific response for a given scenario.
 *
 * @param {object} options The options for the scenario
 * @param {string} options.scenario The scenario to load
 * @param {number} [options.statusCode] The status code to return. defaults to 200
 * @param {boolean} [options.stream] whether to stream the response
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
          'Content-Type': 'application/json',
        },
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

        class TestVertexAI extends VertexAI {
          constructor (...args) {
            super(...args)

            // stub credentials checking
            authStub = sinon.stub(this.googleAuth.constructor.prototype, 'getAccessToken').resolves({})
          }
        }

        const client = new TestVertexAI({
          project: 'datadog-sandbox',
          location: 'us-central1',
        })

        model = client.getGenerativeModel({
          model: 'gemini-1.5-flash-002',
          systemInstruction: 'Please provide an answer',
          generationConfig: {
            maxOutputTokens: 50,
            temperature: 1.0,
          },
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

            assert.strictEqual(span.name, 'vertexai.request')
            assert.strictEqual(span.resource, 'GenerativeModel.generateContent')
            assert.strictEqual(span.meta['span.kind'], 'client')

            assert.strictEqual(span.meta['vertexai.request.model'], 'gemini-1.5-flash-002')
          })

          const { response } = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: 'Hello, how are you?' }] }],
          })
          assert.ok(Object.hasOwn(response, 'candidates'))

          await checkTraces
        })

        it('makes a successful call with a string argument', async () => {
          const checkTraces = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].meta['vertexai.request.model'], 'gemini-1.5-flash-002')
          })

          const { response } = await model.generateContent('Hello, how are you?')

          assert.ok(Object.hasOwn(response, 'candidates'))

          await checkTraces
        })

        describe('with tools', () => {
          useScenario({ scenario: 'generate-content-single-response-with-tools' })

          it('makes a successful call', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              assert.strictEqual(span.meta['vertexai.request.model'], 'gemini-1.5-flash-002')
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

            assert.strictEqual(span.name, 'vertexai.request')
            assert.strictEqual(span.resource, 'GenerativeModel.generateContentStream')
            assert.strictEqual(span.meta['span.kind'], 'client')

            assert.strictEqual(span.meta['vertexai.request.model'], 'gemini-1.5-flash-002')
          })

          const { stream, response } = await model.generateContentStream('Hello, how are you?')

          // check that response is a promise
          assert.ok(response && typeof response.then === 'function')

          const promState = await promiseState(response)
          assert.strictEqual(promState, 'pending') // we shouldn't have consumed the promise

          for await (const chunk of stream) {
            assert.ok(Object.hasOwn(chunk, 'candidates'))
          }

          const result = await response
          assert.ok(Object.hasOwn(result, 'candidates'))

          await checkTraces
        })
      })

      describe('chatSession', () => {
        describe('sendMessage', () => {
          useScenario({ scenario: 'generate-content-single-response' })

          it('makes a successful call', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              assert.strictEqual(span.name, 'vertexai.request')
              assert.strictEqual(span.resource, 'ChatSession.sendMessage')
              assert.strictEqual(span.meta['span.kind'], 'client')

              assert.strictEqual(span.meta['vertexai.request.model'], 'gemini-1.5-flash-002')
            })

            const chat = model.startChat({
              history: [
                { role: 'user', parts: [{ text: 'Foobar?' }] },
                { role: 'model', parts: [{ text: 'Foobar!' }] },
              ],
            })
            const { response } = await chat.sendMessage([{ text: 'Hello, how are you?' }])

            assert.ok(Object.hasOwn(response, 'candidates'))

            await checkTraces
          })

          it('tags a string input', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta['vertexai.request.model'], 'gemini-1.5-flash-002')
            })

            const chat = model.startChat({})
            const { response } = await chat.sendMessage('Hello, how are you?')

            assert.ok(Object.hasOwn(response, 'candidates'))

            await checkTraces
          })

          it('tags an array of string inputs', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta['vertexai.request.model'], 'gemini-1.5-flash-002')
            })

            const chat = model.startChat({})
            const { response } = await chat.sendMessage(['Hello, how are you?', 'What should I do today?'])

            assert.ok(Object.hasOwn(response, 'candidates'))

            await checkTraces
          })
        })

        describe('sendMessageStream', () => {
          useScenario({ scenario: 'generate-content-stream-single-response', statusCode: 200, stream: true })

          it('makes a successful call', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              assert.strictEqual(span.name, 'vertexai.request')
              assert.strictEqual(span.resource, 'ChatSession.sendMessageStream')
              assert.strictEqual(span.meta['span.kind'], 'client')

              assert.strictEqual(span.meta['vertexai.request.model'], 'gemini-1.5-flash-002')
            })

            const chat = model.startChat({})
            const { stream, response } = await chat.sendMessageStream('Hello, how are you?')

            // check that response is a promise
            assert.ok(response && typeof response.then === 'function')

            const promState = await promiseState(response)
            assert.strictEqual(promState, 'pending') // we shouldn't have consumed the promise

            for await (const chunk of stream) {
              assert.ok(Object.hasOwn(chunk, 'candidates'))
            }

            const result = await response
            assert.ok(Object.hasOwn(result, 'candidates'))

            await checkTraces
          })
        })
      })

      describe('errors', () => {
        describe('non-streamed', () => {
          useScenario({ statusCode: 404 })

          it('tags the error', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].error, 1)
            })

            let errorPropagated = false

            try {
              await model.generateContent('Hello, how are you?')
            } catch { errorPropagated = true }

            assert.strictEqual(errorPropagated, true)

            await checkTraces
          })
        })

        describe('streamed', () => {
          useScenario({ scenario: 'malformed-stream', stream: true })

          it('tags the error', async () => {
            const checkTraces = agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].error, 1)
            })

            let errorPropagated = false

            try {
              const { stream } = await model.generateContentStream('Hello, how are you?')
              // eslint-disable-next-line no-unused-vars
              for await (const _ of stream) { /* pass */ }
            } catch { errorPropagated = true }

            assert.strictEqual(errorPropagated, true)

            await checkTraces
          })
        })
      })
    })
  })
})
