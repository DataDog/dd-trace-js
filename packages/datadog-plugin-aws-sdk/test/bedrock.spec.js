'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const {setup} = require('./spec_helpers')

const serviceName = 'bedrock-service-name-test'

describe.only('Plugin', () => {
  describe('aws-sdk (bedrock)', function () {
    setup()

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
      let AWS
      let bedrockRuntime

      const bedrockClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-bedrock-runtime' : 'aws-sdk'
      describe('with configuration', () => {
        before(() => {
          return agent.load('aws-sdk')
        })

        before(done => {
          AWS = require(`../../../versions/${bedrockClientName}@${version}`).get()
          bedrockRuntime = new AWS.BedrockRuntimeClient(
            { endpoint: 'http://127.0.0.1:4566', region: 'us-east-1', ServiceId: serviceName}
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

        const models = {
          Amazon: {
            modelId: 'amazon.titan-text-lite-v1',
            requestBody:
              {
                inputText: `${prompt}`,
                textGenerationConfig: { temperature: temperature, topP: topP, maxTokenCount: maxTokens }
              },
            responseBody: {}
          },
          A21Lab: {
            modelId: 'ai21.jamba-1-5-mini-v1:0',
            requestBody: {},
            responseBody: {}
          },
          Anthropic: {
            modelId: 'anthropic.claude-v2',
            requestBody: {},
            responseBody: {}
          },
          Cohere: {
            modelId: 'cohere.command-light-text-v14',
            requestBody: {},
            responseBody: {}
          },
          Meta: {
            modelId: 'meta.llama3-70b-instruct-v1:0',
            requestBody: {},
            responseBody: {}
          },
          Mistral: {
            modelId: 'mistral.mistral-7b-instruct-v0:2',
            requestBody: {},
            responseBody: {}
          }
        }

        Object.values(models).forEach(model => {
          it(`should invoke model for ${model}`, done => {
            const params = {
              modelId: `${model.ModelId}`,
              body: JSON.stringify(model.requestBody)
            }

            bedrockRuntime.invokeModel(params, (err, response) => {
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
