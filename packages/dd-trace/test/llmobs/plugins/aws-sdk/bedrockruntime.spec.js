'use strict'

const agent = require('../../../plugins/agent')

const nock = require('nock')
const { expectedLLMObsLLMSpanEvent, deepEqualWithMockValues } = require('../../util')
const { models, modelConfig } = require('../../../../../datadog-plugin-aws-sdk/test/fixtures/bedrockruntime')
const chai = require('chai')
const LLMObsAgentProxySpanWriter = require('../../../../src/llmobs/writers/spans/agentProxy')

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

const serviceName = 'bedrock-service-name-test'

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
              .reply(200, response, {
                'x-amzn-bedrock-input-token-count': 50,
                'x-amzn-bedrock-output-token-count': 70,
                'x-amzn-requestid': Date.now().toString()
              })

            const command = new AWS.InvokeModelCommand(request)

            const expectedOutput = { content: model.output }
            if (model.outputRole) expectedOutput.role = model.outputRole

            agent.use(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsAgentProxySpanWriter.prototype.append.getCall(0).args[0]
              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                name: 'bedrock-runtime.command',
                inputMessages: [{ content: model.userPrompt }],
                outputMessages: [expectedOutput],
                tokenMetrics: {
                  input_tokens: model.usage?.inputTokens ?? 50,
                  output_tokens: model.usage?.outputTokens ?? 70,
                  total_tokens: model.usage?.totalTokens ?? 120
                },
                modelName: model.modelId.split('.')[1].toLowerCase(),
                modelProvider: model.provider.toLowerCase(),
                metadata: {
                  temperature: modelConfig.temperature,
                  max_tokens: modelConfig.maxTokens
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
