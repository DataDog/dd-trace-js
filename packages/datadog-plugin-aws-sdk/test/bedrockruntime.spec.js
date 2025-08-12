'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const nock = require('nock')
const { setup } = require('./spec_helpers')
const { models } = require('./fixtures/bedrockruntime')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

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

        before(done => {
          const requireVersion = version === '3.0.0' ? '3.422.0' : '>=3.422.0'
          AWS = require(`../../../versions/${bedrockRuntimeClientName}@${requireVersion}`).get()
          const NodeHttpHandler =
            require(`../../../versions/${bedrockRuntimeClientName}@${requireVersion}`)
              .get('@smithy/node-http-handler')
              .NodeHttpHandler

          bedrockRuntimeClient = new AWS.BedrockRuntimeClient(
            { endpoint: 'http://127.0.0.1:4566', region: 'us-east-1', ServiceId: serviceName, requestHandler: new NodeHttpHandler() }
          )
          done()
        })

        after(async () => {
          nock.cleanAll()
          return agent.close({ ritmReset: false })
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
              .reply(200, response)

            const command = new AWS.InvokeModelCommand(request)

            agent.assertSomeTraces(traces => {
              const span = traces[0][0]
              expect(span.meta).to.include({
                'aws.operation': 'invokeModel',
                'aws.bedrock.request.model': model.modelId.split('.')[1],
                'aws.bedrock.request.model_provider': model.provider.toLowerCase(),
              })
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
