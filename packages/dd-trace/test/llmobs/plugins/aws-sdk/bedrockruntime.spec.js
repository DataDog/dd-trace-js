'use strict'

const chai = require('chai')
const { describe, it, afterEach, before, after } = require('mocha')
const sinon = require('sinon')

const agent = require('../../../plugins/agent')
const { withVersions } = require('../../../setup/mocha')

const { expectedLLMObsLLMSpanEvent, deepEqualWithMockValues } = require('../../util')
const { models, modelConfig } = require('../../../../../datadog-plugin-aws-sdk/test/fixtures/bedrockruntime')
const LLMObsSpanWriter = require('../../../../src/llmobs/writers/spans')

const { expect } = chai

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
          sinon.stub(LLMObsSpanWriter.prototype, 'append')

          // reduce errors related to too many listeners
          process.removeAllListeners('beforeExit')
          LLMObsSpanWriter.prototype.append.reset()

          return agent.load('aws-sdk', {}, {
            llmobs: {
              mlApp: 'test',
              agentlessEnabled: false
            }
          })
        })

        before(() => {
          const requireVersion = version === '3.0.0' ? '3.422.0' : '>=3.422.0'
          AWS = require(`../../../../../../versions/${bedrockRuntimeClientName}@${requireVersion}`).get()
          const NodeHttpHandler =
            require(`../../../../../../versions/${bedrockRuntimeClientName}@${requireVersion}`)
              .get('@smithy/node-http-handler')
              .NodeHttpHandler

          bedrockRuntimeClient = new AWS.BedrockRuntimeClient(
            {
              endpoint: { url: 'http://127.0.0.1:9126/vcr/bedrock-runtime' },
              region: 'us-east-1',
              ServiceId: serviceName,
              requestHandler: new NodeHttpHandler()
            }
          )
        })

        afterEach(() => {
          LLMObsSpanWriter.prototype.append.reset()
        })

        after(() => {
          sinon.restore()
          return agent.close({ ritmReset: false, wipe: true })
        })

        models.forEach(model => {
          it(`should invoke model for provider: ${model.provider} (ModelId: ${model.modelId})`, async () => {
            const request = {
              body: JSON.stringify(model.requestBody),
              contentType: 'application/json',
              accept: 'application/json',
              modelId: model.modelId
            }

            const command = new AWS.InvokeModelCommand(request)

            const expectedOutput = { content: model.response.text }
            if (model.outputRole) expectedOutput.role = model.outputRole

            const tracesPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]
              const spanEvent = LLMObsSpanWriter.prototype.append.getCall(0).args[0]
              const expected = expectedLLMObsLLMSpanEvent({
                span,
                spanKind: 'llm',
                name: 'bedrock-runtime.command',
                inputMessages: [{ content: model.userPrompt }],
                outputMessages: [expectedOutput],
                tokenMetrics: {
                  input_tokens: model.response.inputTokens,
                  output_tokens: model.response.outputTokens,
                  total_tokens: model.response.inputTokens + model.response.outputTokens
                },
                modelName: model.modelId.split('.')[1].toLowerCase(),
                modelProvider: model.provider.toLowerCase(),
                metadata: {
                  temperature: modelConfig.temperature,
                  max_tokens: modelConfig.maxTokens
                },
                tags: { ml_app: 'test', language: 'javascript', integration: 'bedrock' }
              })

              expect(spanEvent).to.deepEqualWithMockValues(expected)
            })

            await bedrockRuntimeClient.send(command)
            await tracesPromise
          })
        })
      })
    })
  })
})
