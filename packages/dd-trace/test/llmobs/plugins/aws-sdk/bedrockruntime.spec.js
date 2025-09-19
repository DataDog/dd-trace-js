'use strict'

const chai = require('chai')
const { describe, it, before } = require('mocha')

const { withVersions } = require('../../../setup/mocha')

const { expectedLLMObsLLMSpanEvent, deepEqualWithMockValues, useLlmObs } = require('../../util')
const { models, modelConfig } = require('../../../../../datadog-plugin-aws-sdk/test/fixtures/bedrockruntime')
const { useEnv } = require('../../../../../../integration-tests/helpers')

const { expect } = chai

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

const serviceName = 'bedrock-service-name-test'

describe('Plugin', () => {
  describe('aws-sdk (bedrockruntime)', function () {
    useEnv({
      AWS_SECRET_ACCESS_KEY: '0000000000/00000000000000000000000000000',
      AWS_ACCESS_KEY_ID: '00000000000000000000'
    })

    const getEvents = useLlmObs({ plugin: 'aws-sdk' })

    withVersions('aws-sdk', ['@aws-sdk/smithy-client', 'aws-sdk'], '>=3', (version, moduleName) => {
      let AWS
      let bedrockRuntimeClient

      const bedrockRuntimeClientName =
        moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-bedrock-runtime' : 'aws-sdk'

      describe('with configuration', () => {
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

        models.forEach(model => {
          it(`should invoke model for provider: ${model.provider} (ModelId: ${model.modelId})`, async () => {
            const request = {
              body: JSON.stringify(model.requestBody),
              contentType: 'application/json',
              accept: 'application/json',
              modelId: model.modelId
            }

            const command = new AWS.InvokeModelCommand(request)
            await bedrockRuntimeClient.send(command)

            const expectedOutput = { content: model.response.text }
            if (model.outputRole) expectedOutput.role = model.outputRole

            const { apmSpans, llmobsSpans } = await getEvents()
            const expected = expectedLLMObsLLMSpanEvent({
              span: apmSpans[0],
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

            expect(llmobsSpans[0]).to.deepEqualWithMockValues(expected)
          })

          it(`should invoke model for provider with streaming: ${model.provider} (ModelId: ${model.modelId})`, async () => { // eslint-disable-line @stylistic/max-len
            const request = {
              body: JSON.stringify(model.requestBody),
              contentType: 'application/json',
              accept: 'application/json',
              modelId: model.modelId
            }

            const command = new AWS.InvokeModelWithResponseStreamCommand(request)

            const stream = await bedrockRuntimeClient.send(command)
            for await (const chunk of stream.body) { // eslint-disable-line no-unused-vars
              // consume the stream
            }

            // some recorded streamed responses are the same as the non-streamed responses
            const expectedResponseObject = model.streamedResponse ?? model.response

            const { apmSpans, llmobsSpans } = await getEvents()
            const expected = expectedLLMObsLLMSpanEvent({
              span: apmSpans[0],
              spanKind: 'llm',
              name: 'bedrock-runtime.command',
              inputMessages: [{ content: model.userPrompt }],
              outputMessages: [{ content: expectedResponseObject.text, role: 'assistant' }],
              tokenMetrics: {
                input_tokens: expectedResponseObject.inputTokens,
                output_tokens: expectedResponseObject.outputTokens,
                total_tokens: expectedResponseObject.inputTokens + expectedResponseObject.outputTokens
              },
              modelName: model.modelId.split('.')[1].toLowerCase(),
              modelProvider: model.provider.toLowerCase(),
              metadata: {
                temperature: modelConfig.temperature,
                max_tokens: modelConfig.maxTokens
              },
              tags: { ml_app: 'test', language: 'javascript', integration: 'bedrock' }
            })

            expect(llmobsSpans[0]).to.deepEqualWithMockValues(expected)
          })
        })
      })
    })
  })
})
