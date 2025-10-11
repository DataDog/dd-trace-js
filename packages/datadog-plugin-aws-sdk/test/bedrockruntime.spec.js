'use strict'

const { expect } = require('chai')
const { describe, it, before, after } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')
const { models } = require('./fixtures/bedrockruntime')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const assert = require('node:assert')

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
            require('../../../versions/@aws-sdk/node-http-handler@>=3')
              .get()
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

        after(async () => {
          return agent.close({ ritmReset: false })
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

            const tracesPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]
              expect(span.meta).to.include({
                'aws.operation': 'invokeModel',
                'aws.bedrock.request.model': model.modelId.split('.')[1],
                'aws.bedrock.request.model_provider': model.provider.toLowerCase(),
              })
            })

            await bedrockRuntimeClient.send(command)
            await tracesPromise
          })

          it(`should invoke model for provider with streaming: ${model.provider} (ModelId: ${model.modelId})`, async () => { // eslint-disable-line @stylistic/max-len
            const request = {
              body: JSON.stringify(model.requestBody),
              contentType: 'application/json',
              accept: 'application/json',
              modelId: model.modelId
            }

            const command = new AWS.InvokeModelWithResponseStreamCommand(request)

            const tracesPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]
              expect(span.meta).to.include({
                'aws.operation': 'invokeModelWithResponseStream',
                'aws.bedrock.request.model': model.modelId.split('.')[1],
                'aws.bedrock.request.model_provider': model.provider.toLowerCase(),
              })
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
      })
    })
  })
})
