'use strict'

const LLMObsAgentProxySpanWriter = require('../../../../src/llmobs/writers/spans/agentProxy')
const agent = require('../../../../../dd-trace/test/plugins/agent')
const {
  expectedLLMObsLLMSpanEvent,
  expectedLLMObsNonLLMSpanEvent,
  deepEqualWithMockValues,
  MOCK_ANY,
  MOCK_STRING
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
      } if (stream) {
        body = fs.createReadStream(path.join(
          __dirname,
          '../../../../../datadog-plugin-google-cloud-vertexai/test/',
          'resources',
          `${scenario}.txt`)
        )
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

describe('integrations', () => {
  let authStub
  let model

  describe('vertexai', () => {
    before(async () => {
      sinon.stub(LLMObsAgentProxySpanWriter.prototype, 'append')

      // reduce errors related to too many listeners
      process.removeAllListeners('beforeExit')

      LLMObsAgentProxySpanWriter.prototype.append.reset()

      return agent.load('google-cloud-vertexai', {}, {
        llmobs: {
          mlApp: 'test'
        }
      })
    })

    afterEach(() => {
      LLMObsAgentProxySpanWriter.prototype.append.reset()
    })

    after(() => {
      require('../../../../../dd-trace').llmobs.disable() // unsubscribe from all events
      sinon.restore()
      return agent.close({ ritmReset: false, wipe: true })
    })

    withVersions('google-cloud-vertexai', '@google-cloud/vertexai', '>=1', version => {
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
    })
  })
})
