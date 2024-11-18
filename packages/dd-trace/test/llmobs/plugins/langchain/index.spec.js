'use strict'

const LLMObsAgentProxySpanWriter = require('../../../../src/llmobs/writers/spans/agentProxy')
const { useEnv } = require('../../../../../../integration-tests/helpers')
const agent = require('../../../../../dd-trace/test/plugins/agent')
const { expectedLLMObsLLMSpanEvent, expectedLLMObsNonLLMSpanEvent, deepEqualWithMockValues } = require('../../util')
const chai = require('chai')

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

const nock = require('nock')
function stubCall ({ base = '', path = '', code = 200, response = {} }) {
  const responses = Array.isArray(response) ? response : [response]
  const times = responses.length
  nock(base).post(path).times(times).reply(() => {
    return [code, responses.shift()]
  })
}

const openAiBaseCompletionInfo = { base: 'https://api.openai.com', path: '/v1/completions' }
const openAiBaseChatInfo = { base: 'https://api.openai.com', path: '/v1/chat/completions' }
const openAiBaseEmbeddingInfo = { base: 'https://api.openai.com', path: '/v1/embeddings' }

describe('integrations', () => {
  let langchainOpenai
  let langchainAnthropic

  let langchainMessages
  let langchainOutputParsers
  let langchainPrompts
  let langchainRunnables

  // so we can verify it gets tagged properly
  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>',
    ANTHROPIC_API_KEY: '<not-a-real-key>'
  })

  describe('langchain', () => {
    before(() => {
      sinon.stub(LLMObsAgentProxySpanWriter.prototype, 'append')

      // reduce errors related to too many listeners
      process.removeAllListeners('beforeExit')

      LLMObsAgentProxySpanWriter.prototype.append.reset()

      return agent.load('langchain', {}, {
        llmobs: {
          mlApp: 'test'
        }
      })
    })

    afterEach(() => {
      nock.cleanAll()
      LLMObsAgentProxySpanWriter.prototype.append.reset()
    })

    after(() => {
      require('../../../../../dd-trace').llmobs.disable() // unsubscribe from all events
      sinon.restore()
      return agent.close({ ritmReset: false, wipe: true })
    })

    withVersions('langchain', ['@langchain/core'], version => {
      describe('langchain', () => {
        beforeEach(() => {
          langchainOpenai = require(`../../../../../../versions/@langchain/openai@${version}`).get()
          langchainAnthropic = require(`../../../../../../versions/@langchain/anthropic@${version}`).get()

          // need to specify specific import in `get(...)`
          langchainMessages = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('@langchain/core/messages')
          langchainOutputParsers = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('@langchain/core/output_parsers')
          langchainPrompts = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('@langchain/core/prompts')
          langchainRunnables = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('@langchain/core/runnables')
        })

        describe('llm', () => {
          it('submits an llm span for an openai llm', async () => {
            stubCall({
              ...openAiBaseCompletionInfo,
              response: {
                choices: [
                  {
                    text: 'Hello, world!'
                  }
                ],
                usage: { prompt_tokens: 8, completion_tokens: 12, otal_tokens: 20 }
              }
            })

            const llm = new langchainOpenai.OpenAI({ model: 'gpt-3.5-turbo-instruct' })

            const checkTraces = agent.use(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]

              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                modelName: 'gpt-3.5-turbo-instruct',
                modelProvider: 'openai',
                name: 'langchain.llms.openai.OpenAI',
                inputMessages: [{ content: 'Hello!' }],
                outputMessages: [{ content: 'Hello, world!' }],
                metadata: { temperature: 0.7, maxTokens: 256 },
                tokenMetrics: { input_tokens: 8, output_tokens: 12, total_tokens: 20 },
                tags: { ml_app: 'test', language: 'javascript' }
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            await llm.invoke('Hello!')

            await checkTraces
          })
        })

        describe('chat model', () => {})

        describe('embedding', () => {})

        describe('chain', () => {})
      })
    })
  })
})
