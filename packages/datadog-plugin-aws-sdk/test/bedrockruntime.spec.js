'use strict'

const assert = require('node:assert')
const { describe, it, before, after } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { setup } = require('./spec_helpers')
const { models, converseRequest } = require('./fixtures/bedrockruntime')
const serviceName = 'bedrock-service-name-test'

describe('Plugin', () => {
  describe('aws-sdk (bedrockruntime)', function () {
    setup()

    withVersions('aws-sdk', ['@aws-sdk/smithy-client', 'aws-sdk'], '>=3', (version, moduleName) => {
      let AWS
      let bedrockRuntimeClient

      const bedrockRuntimeClientName =
        moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-bedrock-runtime' : 'aws-sdk'
      describe('with configuration', () => {
        before(() => {
          return agent.load('aws-sdk')
        })

        before(() => {
          const requireVersion = version === '3.0.0' ? '3.422.0' : '>=3.422.0'
          AWS = require(`../../../versions/${bedrockRuntimeClientName}@${requireVersion}`).get()
          const NodeHttpHandler =
            require(`../../../versions/${bedrockRuntimeClientName}@${requireVersion}`)
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

        after(async () => {
          return agent.close({ ritmReset: false })
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

            const tracesPromise = agent.assertFirstTraceSpan({
              meta: {
                'aws.operation': 'invokeModel',
                'aws.bedrock.request.model': model.modelId.split('.')[1],
                'aws.bedrock.request.model_provider': model.provider.toLowerCase(),
              },
            })

            await bedrockRuntimeClient.send(command)
            await tracesPromise
          })

          it(`should invoke model for provider with streaming: ${model.provider} (ModelId: ${model.modelId})`, async () => { // eslint-disable-line @stylistic/max-len
            const request = {
              body: JSON.stringify(model.requestBody),
              contentType: 'application/json',
              accept: 'application/json',
              modelId: model.modelId,
            }

            const command = new AWS.InvokeModelWithResponseStreamCommand(request)

            const tracesPromise = agent.assertFirstTraceSpan({
              meta: {
                'aws.operation': 'invokeModelWithResponseStream',
                'aws.bedrock.request.model': model.modelId.split('.')[1],
                'aws.bedrock.request.model_provider': model.provider.toLowerCase(),
              },
            })

            const stream = await bedrockRuntimeClient.send(command)
            for await (const chunk of stream.body) {
              const decoded = Buffer.from(chunk.chunk.bytes).toString('utf8')
              const body = JSON.parse(decoded)
              assert.ok(body)
            }

            await tracesPromise
          })
        })

        it('should converse', async function () {
          if (typeof AWS.ConverseCommand !== 'function') return this.skip()
          const command = new AWS.ConverseCommand({ modelId: converseRequest.modelId, ...converseRequest.request })

          const tracesPromise = agent.assertFirstTraceSpan({
            meta: {
              'aws.operation': 'converse',
              'aws.bedrock.request.model': converseRequest.modelId.split('.')[1],
              'aws.bedrock.request.model_provider': converseRequest.provider.toLowerCase(),
            },
          })
          tracesPromise.catch(() => {}) // silence unhandled rejection if `send` throws first

          await bedrockRuntimeClient.send(command)
          await tracesPromise
        })

        it('should converse-stream', async function () {
          if (typeof AWS.ConverseStreamCommand !== 'function') return this.skip()
          const command = new AWS.ConverseStreamCommand({
            modelId: converseRequest.modelId,
            ...converseRequest.request,
          })

          const tracesPromise = agent.assertFirstTraceSpan({
            meta: {
              'aws.operation': 'converseStream',
              'aws.bedrock.request.model': converseRequest.modelId.split('.')[1],
              'aws.bedrock.request.model_provider': converseRequest.provider.toLowerCase(),
            },
          })
          tracesPromise.catch(() => {}) // silence unhandled rejection if stream iteration throws first

          const result = await bedrockRuntimeClient.send(command)
          for await (const _event of result.stream) { // eslint-disable-line no-unused-vars
            // drain
          }
          await tracesPromise
        })
      })
    })
  })
})
