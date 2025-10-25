'use strict'

const { describe, it, beforeEach } = require('mocha')
const semifies = require('semifies')

const { withVersions } = require('../../../setup/mocha')

const {
  useLlmObs,
  assertLlmObsSpanEvent,
  MOCK_STRING,
  MOCK_NUMBER,
} = require('../../util')

describe('integrations', () => {
  let openai

  describe('openai', () => {
    const getEvents = useLlmObs({ plugin: 'openai', closeOptions: { wipe: true } })

    withVersions('openai', 'openai', '<4', version => {
      const moduleRequirePath = `../../../../../../versions/openai@${version}`
      let realVersion

      beforeEach(() => {
        const requiredModule = require(moduleRequirePath)
        const module = requiredModule.get()
        realVersion = requiredModule.version()

        const { Configuration, OpenAIApi } = module

        const configuration = new Configuration({
          apiKey: process.env.OPENAI_API_KEY ?? 'sk-DATADOG-ACCEPTANCE-TESTS',
          basePath: 'http://127.0.0.1:9126/vcr/openai'
        })

        openai = new OpenAIApi(configuration)
      })

      it('submits a completion span', async () => {
        await openai.createCompletion({
          model: 'gpt-3.5-turbo-instruct',
          prompt: 'Hello, OpenAI!',
          max_tokens: 100,
          temperature: 0.5,
          n: 1,
          stream: false,
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'OpenAI.createCompletion',
          inputData: [
            { content: 'Hello, OpenAI!' }
          ],
          outputData: [
            { content: MOCK_STRING }
          ],
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
          modelName: 'gpt-3.5-turbo-instruct',
          modelProvider: 'openai',
          metadata: {
            max_tokens: 100,
            temperature: 0.5,
            n: 1,
            stream: false,
          },
          tags: { ml_app: 'test', integration: 'openai' }
        })
      })

      it('submits a chat completion span', async function () {
        if (semifies(realVersion, '<3.2.0')) {
          this.skip()
        }

        await openai.createChatCompletion({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: 'You are a helpful assistant.'
            },
            {
              role: 'user',
              content: 'Hello, OpenAI!'
            }
          ],
          temperature: 0.5,
          stream: false,
          max_tokens: 100,
          n: 1,
          user: 'dd-trace-test'
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'OpenAI.createChatCompletion',
          inputData: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello, OpenAI!' }
          ],
          outputData: [
            { role: 'assistant', content: MOCK_STRING }
          ],
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
          modelName: 'gpt-3.5-turbo',
          modelProvider: 'openai',
          metadata: {
            max_tokens: 100,
            temperature: 0.5,
            n: 1,
            stream: false,
            user: 'dd-trace-test'
          },
          tags: { ml_app: 'test', integration: 'openai' }
        })
      })

      it('submits an embedding span', async () => {
        await openai.createEmbedding({
          model: 'text-embedding-ada-002',
          input: 'hello world',
          encoding_format: 'base64'
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'embedding',
          name: 'OpenAI.createEmbedding',
          inputData: [
            { text: 'hello world' }
          ],
          outputData: '[1 embedding(s) returned]',
          metrics: { input_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
          modelName: 'text-embedding-ada-002',
          modelProvider: 'openai',
          metadata: { encoding_format: 'base64' },
          tags: { ml_app: 'test', integration: 'openai' }
        })
      })

      // TODO(sabrenner): missing tool_id and type in actual tool call
      it.skip('submits a chat completion span with functions', async function () {
        if (semifies(realVersion, '<3.2.0')) {
          this.skip()
        }

        await openai.createChatCompletion({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: 'What is the weather in New York City?' }],
          functions: [{
            name: 'get_weather',
            description: 'Get the weather in a given city',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string', description: 'The city to get the weather for' }
              }
            }
          }],
          function_call: 'auto',
          stream: false,
        })

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'OpenAI.createChatCompletion',
          modelName: 'gpt-3.5-turbo',
          modelProvider: 'openai',
          inputData: [{ role: 'user', content: 'What is the weather in New York City?' }],
          outputData: [{
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                name: 'get_weather',
                arguments: {
                  city: 'New York City'
                },
                tool_id: MOCK_STRING,
                type: 'function'
              }
            ]
          }],
          metadata: { function_call: 'auto', stream: false },
          tags: { ml_app: 'test', integration: 'openai' },
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER }
        })
      })

      it('submits a completion span with an error', async () => {
        let error

        try {
          await openai.createCompletion({
            model: 'gpt-3.5-turbo', // incorrect model
            prompt: 'Hello, OpenAI!',
            max_tokens: 100,
            temperature: 0.5,
            n: 1,
            stream: false,
          })
        } catch (e) {
          error = e
        }

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'OpenAI.createCompletion',
          inputData: [{ content: 'Hello, OpenAI!' }],
          outputData: [{ content: '' }],
          modelName: 'gpt-3.5-turbo',
          modelProvider: 'openai',
          metadata: { max_tokens: 100, temperature: 0.5, n: 1, stream: false },
          tags: { ml_app: 'test', integration: 'openai' },
          error: {
            type: error.type || error.name,
            message: error.message,
            stack: error.stack
          }
        })
      })

      // TODO(sabrenner): missing metadata should be recorded even on errors
      it.skip('submits a chat completion span with an error', async function () {
        if (semifies(realVersion, '<3.2.0')) {
          this.skip()
        }

        let error

        try {
          await openai.createChatCompletion({
            model: 'gpt-3.5-turbo-instruct', // incorrect model
            messages: [
              {
                role: 'system',
                content: 'You are a helpful assistant.'
              },
              {
                role: 'user',
                content: 'Hello, OpenAI!'
              }
            ],
            temperature: 0.5,
            stream: false,
            max_tokens: 100,
            n: 1,
            user: 'dd-trace-test'
          })
        } catch (e) {
          error = e
        }

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'OpenAI.createChatCompletion',
          inputData: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello, OpenAI!' }
          ],
          outputData: [{ content: '' }],
          modelName: 'gpt-3.5-turbo-instruct',
          modelProvider: 'openai',
          metadata: { max_tokens: 100, temperature: 0.5, n: 1, stream: false, user: 'dd-trace-test' },
          tags: { ml_app: 'test', integration: 'openai' },
          error: {
            type: error.type || error.name,
            message: error.message,
            stack: error.stack
          },
        })
      })
    })
  })
})
