'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')

const serviceName = 'bedrock-service-name-test'

describe.only('Plugin', () => {
  describe('aws-sdk (bedrock)', function () {
    setup()

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
      let AWS
      let bedrockRuntimeClient

      const bedrockRuntimeClientName =
        moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-bedrock-runtime' : 'aws-sdk'
      describe('with configuration', () => {
        before(() => {
          return agent.load('aws-sdk')
        })

        before(done => {
          try {
            AWS = require(`../../../versions/${bedrockRuntimeClientName}@${version}`).get()
          } catch (e) {
            // TODO figure out how to manage bedrock runtime client not found error
            done()
          }
          bedrockRuntimeClient = new AWS.BedrockRuntimeClient(
            { endpoint: 'http://127.0.0.1:4566', region: 'us-east-1', ServiceId: serviceName }
          )
          done()
        })

        after(async () => {
          return agent.close({ ritmReset: false })
        })

        const prompt = 'What is the capital of France?'
        const temperature = 0.5
        const topP = 1
        const maxTokens = 512
        const stopSequences = []

        const models = [
          {
            provider: 'amazon',
            modelId: 'amazon.titan-text-lite-v1',
            requestBody:
              {
                inputText: `${prompt}`,
                textGenerationConfig: { temperature, topP, maxTokenCount: maxTokens }
              },
            // TODO figure out how to mock the response body instead of calling the client
            responseBody: {}
          },
          // TODO add a test for the AI21 model
          {
            provider: 'ai21',
            modelId: 'ai21.jamba-1-5-mini-v1:0',
            requestBody: {},
            responseBody: {}
          },
          // TODO add a test for the Anthropic model
          {
            provider: 'anthropic',
            modelId: 'anthropic.claude-v2',
            requestBody: {},
            responseBody: {}
          },
          // TODO add a test for the Cohere model
          {
            provider: 'cohere',
            modelId: 'cohere.command-light-text-v14',
            requestBody: {},
            responseBody: {}
          },
          // TODO add a test for the Meta model
          {
            provider: 'meta',
            modelId: 'meta.llama3-70b-instruct-v1:0',
            requestBody: {},
            responseBody: {}
          },
          // TODO add a test for the Mistral model
          {
            provider: 'mistral',
            modelId: 'mistral.mistral-7b-instruct-v0:2',
            requestBody: {},
            responseBody: {}
          }
        ]

        models.forEach(model => {
          it(`should invoke model for provider:${model.provider}`, done => {
            const request = {
              body: JSON.stringify(model.requestBody),
              contentType: 'application/json',
              accept: 'application/json',
              modelId: `${model.ModelId}`
            }

            const response = JSON.stringify(model.responseBody)

            // TODO figure out why InvokeModelCommand is undefined
            const command = new AWS.InvokeModelCommand(request)

            // TODO mock the send command to return a specific response
            bedrockRuntimeClient.send(command, (err, response) => {
              if (err) return done(err)

              agent.use(traces => {
                const span = traces[0][0]
                expect(span.meta).to.include({
                  'resource.name': 'invokeModel',
                  'aws.bedrock.request.model': `${model.ModelId}`,
                  'aws.bedrock.request.model_provider': `${model.name}`,
                  'aws.bedrock.request.prompt': prompt,
                  'aws.bedrock.request.temperature': temperature,
                  'aws.bedrock.request.top_p': topP,
                  'aws.bedrock.request.max_tokens': maxTokens,
                  'aws.bedrock.request.stop_sequences': stopSequences
                })
                done()
              }).catch(done)
            })
          })
        })
      })
    })
  })
})
