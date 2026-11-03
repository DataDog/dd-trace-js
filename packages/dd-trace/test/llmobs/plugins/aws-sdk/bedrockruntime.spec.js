'use strict'

const assert = require('node:assert')

const { describe, it, before } = require('mocha')

const { assertLlmObsSpanEvent, useLlmObs, MOCK_STRING, MOCK_NUMBER } = require('../../util')
const { withAwsSdkVersions } = require('../../../../../datadog-plugin-aws-sdk/test/spec_helpers')
const {
  models,
  modelConfig,
  cacheWriteRequest,
  cacheReadRequest,
  converseRequest,
  converseToolResultRequest,
  converseUnsupportedBlocksRequest,
} = require('../../../../../datadog-plugin-aws-sdk/test/fixtures/bedrockruntime')
const { useEnv } = require('../../../../../../integration-tests/helpers')

const serviceName = 'bedrock-service-name-test'

function expectedMetrics (response, includeCache = false) {
  const metrics = {
    input_tokens: response.inputTokens,
    output_tokens: response.outputTokens,
    total_tokens: typeof response.inputTokens === 'number' && typeof response.outputTokens === 'number'
      ? response.inputTokens + response.outputTokens
      : MOCK_NUMBER,
  }
  if (includeCache && response.cacheReadTokens != null) {
    metrics.cache_read_input_tokens = response.cacheReadTokens
  }
  if (includeCache && response.cacheWriteTokens != null) {
    metrics.cache_write_input_tokens = response.cacheWriteTokens
  }
  return metrics
}

describe('Plugin', () => {
  describe('aws-sdk (bedrockruntime)', function () {
    useEnv({
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '0000000000/00000000000000000000000000000',
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '00000000000000000000',
    })

    const { getEvents } = useLlmObs({ plugin: 'aws-sdk' })

    withAwsSdkVersions('>=3', (version, moduleName) => {
      let AWS
      let bedrockRuntimeClient

      const bedrockRuntimeClientName =
        moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-bedrock-runtime' : 'aws-sdk'

      describe('with configuration', () => {
        before(() => {
          const requireVersion = version === '3.0.0' ? '3.422.0' : '3'
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
              requestHandler: new NodeHttpHandler(),
            }
          )
        })

        models.forEach(model => {
          it(`should invoke model for provider: ${model.provider} (ModelId: ${model.modelId})`, async () => {
            const request = {
              body: JSON.stringify(model.requestBody),
              contentType: 'application/json',
              accept: 'application/json',
              modelId: model.modelId,
            }

            const command = new AWS.InvokeModelCommand(request)
            await bedrockRuntimeClient.send(command)

            const expectedOutput = {
              content: model.response.text,
              role: model.outputRole ?? (Array.isArray(model.requestBody.messages) ? 'assistant' : ''),
            }

            const { apmSpans, llmobsSpans } = await getEvents()
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'llm',
              name: 'bedrock-runtime.command',
              inputMessages: model.systemPrompt
                ? [
                    { content: model.systemPrompt, role: 'system' },
                    { content: model.userPrompt, role: 'user' },
                  ]
                : [
                    {
                      content: model.userPrompt,
                      role: model.modelId.startsWith('anthropic.') && Array.isArray(model.requestBody.messages)
                        ? 'user'
                        : '',
                    },
                  ],
              outputMessages: [expectedOutput],
              metrics: expectedMetrics(model.response, model.modelId.includes('nova')),
              modelName: model.modelId.toLowerCase(),
              modelProvider: 'amazon_bedrock',
              metadata: {
                temperature: modelConfig.temperature,
                max_tokens: modelConfig.maxTokens,
              },
              tags: { ml_app: 'test', integration: 'bedrock' },
            })
          })

          it(`should invoke model for provider with streaming: ${model.provider} (ModelId: ${model.modelId})`, async () => { // eslint-disable-line @stylistic/max-len
            const request = {
              body: JSON.stringify(model.requestBody),
              contentType: 'application/json',
              accept: 'application/json',
              modelId: model.modelId,
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
              inputMessages: model.systemPrompt
                ? [
                    { content: model.systemPrompt, role: 'system' },
                    { content: model.userPrompt, role: 'user' },
                  ]
                : [
                    {
                      content: model.userPrompt,
                      role: model.modelId.startsWith('anthropic.') && Array.isArray(model.requestBody.messages)
                        ? 'user'
                        : '',
                    },
                  ],
              outputMessages: [{ content: expectedResponseObject.text, role: 'assistant' }],
              metrics: expectedMetrics({
                ...expectedResponseObject,
                cacheReadTokens: model.response.cacheReadTokens,
                cacheWriteTokens: model.response.cacheWriteTokens,
              }, model.modelId.includes('nova')),
              modelName: model.modelId.toLowerCase(),
              modelProvider: 'amazon_bedrock',
              metadata: {
                temperature: modelConfig.temperature,
                max_tokens: modelConfig.maxTokens,
              },
              tags: { ml_app: 'test', integration: 'bedrock' },
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
            modelId: cacheWriteRequest.modelId,
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
            inputMessages: [
              { content: 'You are a geography expert'.repeat(200) + cacheWriteRequest.userPrompt, role: 'user' },
            ],
            outputMessages: [expectedOutput],
            metrics: expectedMetrics(cacheWriteRequest.response, true),
            modelName: cacheWriteRequest.modelId.toLowerCase(),
            modelProvider: 'amazon_bedrock',
            metadata: {
              temperature: cacheWriteRequest.requestBody.temperature,
              max_tokens: cacheWriteRequest.requestBody.max_tokens,
            },
            tags: { ml_app: 'test', integration: 'bedrock' },
          })
        })

        it('should invoke model and handle cache write tokens for streamed response', async () => {
          const request = {
            body: JSON.stringify(cacheWriteRequest.requestBody),
            contentType: 'application/json',
            accept: 'application/json',
            modelId: cacheWriteRequest.modelId,
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
            inputMessages: [
              { content: 'You are a geography expert'.repeat(200) + cacheWriteRequest.userPrompt, role: 'user' },
            ],
            outputMessages: [expectedOutput],
            metrics: expectedMetrics(cacheWriteRequest.response, true),
            modelName: cacheWriteRequest.modelId.toLowerCase(),
            modelProvider: 'amazon_bedrock',
            metadata: {
              temperature: cacheWriteRequest.requestBody.temperature,
              max_tokens: cacheWriteRequest.requestBody.max_tokens,
            },
            tags: { ml_app: 'test', integration: 'bedrock' },
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
            modelId: cacheReadRequest.modelId,
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
            inputMessages: [
              { content: 'You are a geography expert'.repeat(200) + cacheReadRequest.userPrompt, role: '' },
            ],
            outputMessages: [expectedOutput],
            metrics: {
              input_tokens: cacheReadRequest.response.inputTokens,
              output_tokens: cacheReadRequest.response.outputTokens,
              total_tokens: cacheReadRequest.response.inputTokens + cacheReadRequest.response.outputTokens,
              cache_read_input_tokens: cacheReadRequest.response.cacheReadTokens,
              cache_write_input_tokens: cacheReadRequest.response.cacheWriteTokens,
            },
            modelName: cacheReadRequest.modelId.toLowerCase(),
            modelProvider: 'amazon_bedrock',
            metadata: {
              temperature: cacheReadRequest.requestBody.temperature,
              max_tokens: cacheReadRequest.requestBody.max_tokens,
            },
            tags: { ml_app: 'test', integration: 'bedrock' },
          })
        })

        const converseAssertion = (tokens) => ({
          spanKind: 'llm',
          name: 'bedrock-runtime.command',
          inputMessages: [
            { content: converseRequest.systemPrompt, role: 'system' },
            { content: converseRequest.userPrompt, role: 'user' },
          ],
          outputMessages: [{
            role: converseRequest.response.role,
            tool_calls: [{
              name: converseRequest.response.toolCall.name,
              arguments: converseRequest.response.toolCall.arguments,
              tool_id: MOCK_STRING,
              type: 'toolUse',
            }],
          }],
          toolDefinitions: converseRequest.request.toolConfig.tools.map(({ toolSpec }) => ({
            name: toolSpec.name,
            description: toolSpec.description,
            schema: toolSpec.inputSchema,
          })),
          metrics: expectedMetrics(tokens),
          modelName: converseRequest.modelId.toLowerCase(),
          modelProvider: 'amazon_bedrock',
          metadata: {
            temperature: modelConfig.temperature,
            max_tokens: modelConfig.maxTokens,
            stop_reason: converseRequest.response.stopReason,
          },
          tags: { ml_app: 'test', integration: 'bedrock' },
        })

        it('should converse', async function () {
          if (typeof AWS.ConverseCommand !== 'function') return this.skip()
          const command = new AWS.ConverseCommand({ modelId: converseRequest.modelId, ...converseRequest.request })
          await bedrockRuntimeClient.send(command)

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], { ...converseAssertion(converseRequest.response), span: apmSpans[0] })
        })

        it('should converse-stream', async function () {
          if (typeof AWS.ConverseStreamCommand !== 'function') return this.skip()
          const command = new AWS.ConverseStreamCommand({
            modelId: converseRequest.modelId,
            ...converseRequest.request,
          })
          const result = await bedrockRuntimeClient.send(command)
          for await (const _event of result.stream) { // eslint-disable-line no-unused-vars
            // drain
          }

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], {
            ...converseAssertion(converseRequest.streamedResponse),
            span: apmSpans[0],
          })
        })

        it('should converse-stream a text answer after tool results in the history', async function () {
          if (typeof AWS.ConverseStreamCommand !== 'function') return this.skip()
          const command = new AWS.ConverseStreamCommand({
            modelId: converseToolResultRequest.modelId,
            ...converseToolResultRequest.request,
          })
          const result = await bedrockRuntimeClient.send(command)
          for await (const _event of result.stream) { // eslint-disable-line no-unused-vars
            // drain
          }

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'bedrock-runtime.command',
            inputMessages: [
              { content: converseToolResultRequest.systemPrompt, role: 'system' },
              { content: converseToolResultRequest.userPrompt, role: 'user' },
              {
                role: 'assistant',
                tool_calls: [{
                  name: 'fetch_concept',
                  arguments: { concept: 'tracing' },
                  tool_id: converseToolResultRequest.toolUseId,
                  type: 'toolUse',
                }],
              },
              {
                role: 'user',
                tool_results: [{
                  name: '',
                  result: 'Distributed tracing tracks requests across services.',
                  tool_id: converseToolResultRequest.toolUseId,
                  type: 'toolResult',
                }],
              },
              {
                role: 'user',
                tool_results: [{
                  name: '',
                  result: '{"source":"docs"}',
                  tool_id: converseToolResultRequest.toolUseId,
                  type: 'toolResult',
                }],
              },
            ],
            outputMessages: [{ role: 'assistant', content: MOCK_STRING }],
            toolDefinitions: converseToolResultRequest.request.toolConfig.tools.map(({ toolSpec }) => ({
              name: toolSpec.name,
              description: toolSpec.description,
              schema: toolSpec.inputSchema,
            })),
            metrics: expectedMetrics({ inputTokens: MOCK_NUMBER, outputTokens: MOCK_NUMBER }),
            modelName: converseToolResultRequest.modelId.toLowerCase(),
            modelProvider: 'amazon_bedrock',
            metadata: {
              temperature: modelConfig.temperature,
              max_tokens: modelConfig.maxTokens,
              stop_reason: MOCK_STRING,
            },
            tags: { ml_app: 'test', integration: 'bedrock' },
          })
        })

        it('should label unsupported converse content blocks and tool-result items', async function () {
          if (typeof AWS.ConverseCommand !== 'function') return this.skip()
          const { response } = converseUnsupportedBlocksRequest
          const command = new AWS.ConverseCommand({
            modelId: converseUnsupportedBlocksRequest.modelId,
            ...converseUnsupportedBlocksRequest.request,
          })
          await bedrockRuntimeClient.send(command)

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'bedrock-runtime.command',
            inputMessages: [{ content: converseUnsupportedBlocksRequest.userPrompt, role: 'user' }],
            outputMessages: [{
              role: 'assistant',
              content: response.unsupportedContent,
            }, {
              role: 'user',
              tool_results: [{
                name: '',
                result: response.unsupportedToolResult,
                tool_id: response.toolResultId,
                type: 'toolResult',
              }],
            }],
            metrics: expectedMetrics(response),
            modelName: converseUnsupportedBlocksRequest.modelId.toLowerCase(),
            modelProvider: 'amazon_bedrock',
            metadata: {
              temperature: modelConfig.temperature,
              max_tokens: modelConfig.maxTokens,
              stop_reason: response.stopReason,
            },
            tags: { ml_app: 'test', integration: 'bedrock' },
          })
        })

        it('should invoke model and handle cache read tokens for streamed response', async () => {
          const request = {
            body: JSON.stringify(cacheReadRequest.requestBody),
            contentType: 'application/json',
            accept: 'application/json',
            modelId: cacheReadRequest.modelId,
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
            inputMessages: [
              { content: 'You are a geography expert'.repeat(200) + cacheReadRequest.userPrompt, role: 'user' },
            ],
            outputMessages: [expectedOutput],
            metrics: expectedMetrics(cacheReadRequest.response, true),
            modelName: cacheReadRequest.modelId.toLowerCase(),
            modelProvider: 'amazon_bedrock',
            metadata: {
              temperature: cacheReadRequest.requestBody.temperature,
              max_tokens: cacheReadRequest.requestBody.max_tokens,
            },
            tags: { ml_app: 'test', integration: 'bedrock' },
          })
        })

        // MLOS-591 regression: `bedrockruntime` registers its LLMObs span from
        // `setLLMObsTags` rather than the inherited `LLMObsPlugin.start`. The
        // dd-go LLMObs trace-indexer needs `llmobs_trace_id` /
        // `llmobs_parent_id` on the local trace tags so OTel `gen_ai.*` spans
        // share an LLMObs trace with this bedrock span. The first model is
        // enough — bridge-tag plumbing is not per-model.
        it('writes otel bridge tags onto the apm span meta', async () => {
          const model = models[0]
          const command = new AWS.InvokeModelCommand({
            body: JSON.stringify(model.requestBody),
            contentType: 'application/json',
            accept: 'application/json',
            modelId: model.modelId,
          })

          await bedrockRuntimeClient.send(command)

          const { apmSpans } = await getEvents()
          const apmMeta = apmSpans[0].meta
          assert.match(apmMeta.llmobs_trace_id, /^[0-9a-f]{32}$/)
          assert.ok(apmMeta.llmobs_parent_id)
          assert.strictEqual(apmMeta['_dd.llmobs.submitted'], '1')
        })
      })
    })
  })
})
