'use strict'

const { describe, it, before } = require('mocha')

const { withVersions } = require('../../../setup/mocha')

const { assertLlmObsSpanEvent, useLlmObs } = require('../../util')
const {
  models,
  modelConfig,
  cacheWriteRequest,
  cacheReadRequest
} = require('../../../../../datadog-plugin-aws-sdk/test/fixtures/bedrockruntime')
const { useEnv } = require('../../../../../../integration-tests/helpers')

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
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'llm',
              name: 'bedrock-runtime.command',
              inputData: model.systemPrompt
                ? [
                    { content: model.systemPrompt, role: 'system' },
                    { content: model.userPrompt, role: 'user' }
                  ]
                : [
                    { content: model.userPrompt }
                  ],
              outputData: [expectedOutput],
              metrics: {
                input_tokens: model.response.inputTokens,
                output_tokens: model.response.outputTokens,
                total_tokens: model.response.inputTokens + model.response.outputTokens,
                cache_read_input_tokens: model.response.cacheReadTokens,
                cache_write_input_tokens: model.response.cacheWriteTokens
              },
              modelName: model.modelId.split('.')[1].toLowerCase(),
              modelProvider: model.provider.toLowerCase(),
              metadata: {
                temperature: modelConfig.temperature,
                max_tokens: modelConfig.maxTokens
              },
              tags: { ml_app: 'test', integration: 'bedrock' }
            })
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
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'llm',
              name: 'bedrock-runtime.command',
              inputData: model.systemPrompt
                ? [
                    { content: model.systemPrompt, role: 'system' },
                    { content: model.userPrompt, role: 'user' }
                  ]
                : [
                    { content: model.userPrompt }
                  ],
              outputData: [{ content: expectedResponseObject.text, role: 'assistant' }],
              metrics: {
                input_tokens: expectedResponseObject.inputTokens,
                output_tokens: expectedResponseObject.outputTokens,
                total_tokens: expectedResponseObject.inputTokens + expectedResponseObject.outputTokens,
                cache_read_input_tokens: model.response.cacheReadTokens,
                cache_write_input_tokens: model.response.cacheWriteTokens
              },
              modelName: model.modelId.split('.')[1].toLowerCase(),
              modelProvider: model.provider.toLowerCase(),
              metadata: {
                temperature: modelConfig.temperature,
                max_tokens: modelConfig.maxTokens
              },
              tags: { ml_app: 'test', integration: 'bedrock' }
            })
          })
        })

        // TODO(sabrenner): Fix this test - no output role of "assistant"
        it.skip('should invoke model and handle cache write tokens', async () => {
          /**
           * This test verifies that invoking a Bedrock model correctly handles cache write tokens.
           * If updates are made to this test, a new cassette will need to be generated. Please
           * ensure that the cassette has cache write tokens.
           */
          const request = {
            body: JSON.stringify(cacheWriteRequest.requestBody),
            contentType: 'application/json',
            accept: 'application/json',
            modelId: cacheWriteRequest.modelId
          }

          const command = new AWS.InvokeModelCommand(request)
          await bedrockRuntimeClient.send(command)

          const expectedOutput = { content: cacheWriteRequest.response.text }
          if (cacheWriteRequest.outputRole) expectedOutput.role = cacheWriteRequest.outputRole

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'bedrock-runtime.command',
            inputData: [{ content: 'You are a geography expert'.repeat(200) + cacheWriteRequest.userPrompt }],
            outputData: [expectedOutput],
            metrics: {
              input_tokens: cacheWriteRequest.response.inputTokens,
              output_tokens: cacheWriteRequest.response.outputTokens,
              total_tokens: cacheWriteRequest.response.inputTokens + cacheWriteRequest.response.outputTokens,
              cache_read_input_tokens: cacheWriteRequest.response.cacheReadTokens,
              cache_write_input_tokens: cacheWriteRequest.response.cacheWriteTokens
            },
            modelName: cacheWriteRequest.modelId.split('.')[2].toLowerCase(),
            modelProvider: cacheWriteRequest.provider.toLowerCase(),
            metadata: {
              temperature: cacheWriteRequest.requestBody.temperature,
              max_tokens: cacheWriteRequest.requestBody.max_tokens
            },
            tags: { ml_app: 'test', integration: 'bedrock' }
          })
        })

        it('should invoke model and handle cache write tokens for streamed response', async () => {
          const request = {
            body: JSON.stringify(cacheWriteRequest.requestBody),
            contentType: 'application/json',
            accept: 'application/json',
            modelId: cacheWriteRequest.modelId
          }

          const command = new AWS.InvokeModelWithResponseStreamCommand(request)
          await bedrockRuntimeClient.send(command)

          const stream = await bedrockRuntimeClient.send(command)
          for await (const chunk of stream.body) { // eslint-disable-line no-unused-vars
            // consume the stream
          }

          const expectedOutput = { content: cacheWriteRequest.response.text }
          if (cacheWriteRequest.outputRole) expectedOutput.role = cacheWriteRequest.outputRole

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'bedrock-runtime.command',
            inputData: [{ content: 'You are a geography expert'.repeat(200) + cacheWriteRequest.userPrompt }],
            outputData: [expectedOutput],
            metrics: {
              input_tokens: cacheWriteRequest.response.inputTokens,
              output_tokens: cacheWriteRequest.response.outputTokens,
              total_tokens: cacheWriteRequest.response.inputTokens + cacheWriteRequest.response.outputTokens,
              cache_read_input_tokens: cacheWriteRequest.response.cacheReadTokens,
              cache_write_input_tokens: cacheWriteRequest.response.cacheWriteTokens
            },
            modelName: cacheWriteRequest.modelId.split('.')[2].toLowerCase(),
            modelProvider: cacheWriteRequest.provider.toLowerCase(),
            metadata: {
              temperature: cacheWriteRequest.requestBody.temperature,
              max_tokens: cacheWriteRequest.requestBody.max_tokens
            },
            tags: { ml_app: 'test', integration: 'bedrock' }
          })
        })

        // TODO(sabrenner): Fix this test - no output role of "assistant"
        it.skip('should invoke model and handle cache read tokens', async () => {
          /**
           * This test verifies that invoking a Bedrock model correctly handles cache read tokens.
           * If updates are made to this test, a new cassette will need to be generated. Please
           * ensure that the cassette has cache read tokens. For example, you may need to
           * generate the cassette once, delete it, then generate the cassette again to ensure
           * the prompt is cached.
           */
          const request = {
            body: JSON.stringify(cacheReadRequest.requestBody),
            contentType: 'application/json',
            accept: 'application/json',
            modelId: cacheReadRequest.modelId
          }

          const command = new AWS.InvokeModelCommand(request)
          await bedrockRuntimeClient.send(command)

          const expectedOutput = { content: cacheReadRequest.response.text }
          if (cacheReadRequest.outputRole) expectedOutput.role = cacheReadRequest.outputRole

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'bedrock-runtime.command',
            inputData: [{ content: 'You are a geography expert'.repeat(200) + cacheReadRequest.userPrompt }],
            outputData: [expectedOutput],
            metrics: {
              input_tokens: cacheReadRequest.response.inputTokens,
              output_tokens: cacheReadRequest.response.outputTokens,
              total_tokens: cacheReadRequest.response.inputTokens + cacheReadRequest.response.outputTokens,
              cache_read_input_tokens: cacheReadRequest.response.cacheReadTokens,
              cache_write_input_tokens: cacheReadRequest.response.cacheWriteTokens
            },
            modelName: cacheReadRequest.modelId.split('.')[2].toLowerCase(),
            modelProvider: cacheReadRequest.provider.toLowerCase(),
            metadata: {
              temperature: cacheReadRequest.requestBody.temperature,
              max_tokens: cacheReadRequest.requestBody.max_tokens
            },
            tags: { ml_app: 'test', integration: 'bedrock' }
          })
        })

        it('should invoke model and handle cache read tokens for streamed response', async () => {
          const request = {
            body: JSON.stringify(cacheReadRequest.requestBody),
            contentType: 'application/json',
            accept: 'application/json',
            modelId: cacheReadRequest.modelId
          }

          const command = new AWS.InvokeModelWithResponseStreamCommand(request)
          const stream = await bedrockRuntimeClient.send(command)
          for await (const chunk of stream.body) { // eslint-disable-line no-unused-vars
            // consume the stream
          }

          await bedrockRuntimeClient.send(command)

          const expectedOutput = { content: cacheReadRequest.response.text }
          if (cacheReadRequest.outputRole) expectedOutput.role = cacheReadRequest.outputRole

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'bedrock-runtime.command',
            inputData: [{ content: 'You are a geography expert'.repeat(200) + cacheReadRequest.userPrompt }],
            outputData: [expectedOutput],
            metrics: {
              input_tokens: cacheReadRequest.response.inputTokens,
              output_tokens: cacheReadRequest.response.outputTokens,
              total_tokens: cacheReadRequest.response.inputTokens + cacheReadRequest.response.outputTokens,
              cache_read_input_tokens: cacheReadRequest.response.cacheReadTokens,
              cache_write_input_tokens: cacheReadRequest.response.cacheWriteTokens
            },
            modelName: cacheReadRequest.modelId.split('.')[2].toLowerCase(),
            modelProvider: cacheReadRequest.provider.toLowerCase(),
            metadata: {
              temperature: cacheReadRequest.requestBody.temperature,
              max_tokens: cacheReadRequest.requestBody.max_tokens
            },
            tags: { ml_app: 'test', integration: 'bedrock' }
          })
        })
      })
    })
  })
})
