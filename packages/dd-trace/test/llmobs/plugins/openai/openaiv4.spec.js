'use strict'

const { describe, it, beforeEach } = require('mocha')
const semifies = require('semifies')

const { withVersions } = require('../../../setup/mocha')

const {
  useLlmObs,
  assertLlmObsSpanEvent,
  MOCK_STRING,
  MOCK_NUMBER
} = require('../../util')

const assert = require('node:assert')

describe('integrations', () => {
  let openai
  let azureOpenai
  let deepseekOpenai

  describe('openai', () => {
    const getEvents = useLlmObs({ plugin: 'openai', closeOptions: { wipe: true } })

    withVersions('openai', 'openai', '>=4', version => {
      const moduleRequirePath = `../../../../../../versions/openai@${version}`
      let realVersion

      beforeEach(() => {
        const requiredModule = require(moduleRequirePath)
        const module = requiredModule.get()
        realVersion = requiredModule.version()

        const OpenAI = module

        openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY ?? 'test',
          baseURL: 'http://127.0.0.1:9126/vcr/openai'
        })

        const AzureOpenAI = OpenAI.AzureOpenAI ?? OpenAI
        if (OpenAI.AzureOpenAI) {
          azureOpenai = new AzureOpenAI({
            endpoint: 'http://127.0.0.1:9126/vcr/azure-openai',
            apiKey: 'test',
            apiVersion: '2024-05-01-preview'
          })
        } else {
          azureOpenai = new OpenAI({
            baseURL: 'http://127.0.0.1:9126/vcr/azure-openai',
            apiKey: 'test',
            apiVersion: '2024-05-01-preview'
          })
        }

        deepseekOpenai = new OpenAI({
          baseURL: 'http://127.0.0.1:9126/vcr/deepseek',
          apiKey: process.env.DEEPSEEK_API_KEY ?? 'test'
        })
      })

      it('submits a completion span', async () => {
        await openai.completions.create({
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
          inputMessages: [
            { content: 'Hello, OpenAI!' }
          ],
          outputMessages: [
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

      it('submits a chat completion span', async () => {
        await openai.chat.completions.create({
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
          inputMessages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello, OpenAI!' }
          ],
          outputMessages: [
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
        await openai.embeddings.create({
          model: 'text-embedding-ada-002',
          input: 'hello world',
          encoding_format: 'base64'
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'embedding',
          name: 'OpenAI.createEmbedding',
          inputDocuments: [
            { text: 'hello world' }
          ],
          outputValue: '[1 embedding(s) returned]',
          metrics: { input_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
          modelName: 'text-embedding-ada-002',
          modelProvider: 'openai',
          metadata: { encoding_format: 'base64' },
          tags: { ml_app: 'test', integration: 'openai' }
        })
      })

      it('submits a chat completion span with tools', async function () {
        if (semifies(realVersion, '<=4.16.0')) {
          this.skip()
        }

        await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: 'What is the weather in New York City?' }],
          tools: [{
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get the weather in a given city',
              parameters: {
                type: 'object',
                properties: {
                  city: { type: 'string', description: 'The city to get the weather for' }
                }
              }
            }
          }],
          tool_choice: 'auto',
          stream: false,
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'OpenAI.createChatCompletion',
          modelName: 'gpt-3.5-turbo',
          modelProvider: 'openai',
          inputMessages: [{ role: 'user', content: 'What is the weather in New York City?' }],
          outputMessages: [{
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
          metadata: { tool_choice: 'auto', stream: false },
          tags: { ml_app: 'test', integration: 'openai' },
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER }
        })
      })

      describe('stream', function () {
        beforeEach(function () {
          if (semifies(realVersion, '<=4.1.0')) {
            this.skip()
          }
        })

        it('submits a streamed completion span', async () => {
          const stream = await openai.completions.create({
            model: 'gpt-3.5-turbo-instruct',
            prompt: 'Hello, OpenAI!',
            max_tokens: 100,
            temperature: 0.5,
            n: 1,
            stream: true,
            stream_options: {
              include_usage: true,
            },
          })

          for await (const part of stream) {
            assert.ok(part, 'Expected part to be truthy')
          }

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'OpenAI.createCompletion',
            inputMessages: [
              { content: 'Hello, OpenAI!' }
            ],
            outputMessages: [
              { content: '\n\nHello! How can I assist you?' }
            ],
            metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
            modelName: 'gpt-3.5-turbo-instruct',
            modelProvider: 'openai',
            metadata: {
              max_tokens: 100,
              temperature: 0.5,
              n: 1,
              stream: true,
              stream_options: { include_usage: true }
            },
            tags: { ml_app: 'test', integration: 'openai' }
          })
        })

        it('submits a streamed chat completion span', async () => {
          const stream = await openai.chat.completions.create({
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
            stream: true,
            max_tokens: 100,
            n: 1,
            user: 'dd-trace-test',
            stream_options: {
              include_usage: true,
            },
          })

          for await (const part of stream) {
            assert.ok(part, 'Expected part to be truthy')
          }

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'OpenAI.createChatCompletion',
            inputMessages: [
              { role: 'system', content: 'You are a helpful assistant.' },
              { role: 'user', content: 'Hello, OpenAI!' }
            ],
            outputMessages: [
              { role: 'assistant', content: 'Hello! How can I assist you today?' }
            ],
            metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
            modelName: 'gpt-3.5-turbo',
            modelProvider: 'openai',
            metadata: {
              max_tokens: 100,
              temperature: 0.5,
              n: 1,
              stream: true,
              user: 'dd-trace-test',
              stream_options: { include_usage: true }
            },
            tags: { ml_app: 'test', integration: 'openai' }
          })
        })

        it('submits a chat completion span with tools stream', async function () {
          if (semifies(realVersion, '<=4.16.0')) {
            this.skip()
          }

          const stream = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: 'What is the weather in New York City?' }],
            tools: [{
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get the weather in a given city',
                parameters: {
                  type: 'object',
                  properties: {
                    city: { type: 'string', description: 'The city to get the weather for' }
                  }
                }
              }
            }],
            tool_choice: 'auto',
            stream: true,
            stream_options: {
              include_usage: true,
            },
          })

          for await (const part of stream) {
            assert.ok(part, 'Expected part to be truthy')
          }

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'OpenAI.createChatCompletion',
            modelName: 'gpt-3.5-turbo',
            modelProvider: 'openai',
            inputMessages: [{ role: 'user', content: 'What is the weather in New York City?' }],
            outputMessages: [{
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  name: 'get_weather',
                  arguments: { city: 'New York City' },
                  type: 'function',
                  tool_id: MOCK_STRING
                }
              ]
            }],
            metadata: {
              tool_choice: 'auto',
              stream: true,
              stream_options: { include_usage: true }
            },
            tags: { ml_app: 'test', integration: 'openai' },
            metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER }
          })
        })
      })

      it('submits a completion span with an error', async () => {
        let error

        try {
          await openai.completions.create({
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
          inputMessages: [{ content: 'Hello, OpenAI!' }],
          outputMessages: [{ content: '' }],
          modelName: 'gpt-3.5-turbo',
          modelProvider: 'openai',
          metadata: { max_tokens: 100, temperature: 0.5, n: 1, stream: false },
          tags: { ml_app: 'test', integration: 'openai' },
          error: {
            type: 'Error',
            message: error.message,
            stack: error.stack
          }
        })
      })

      // TODO(sabrenner): missing metadata should be recorded even on errors
      it.skip('submits a chat completion span with an error', async () => {
        let error

        try {
          await openai.chat.completions.create({
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
          inputMessages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello, OpenAI!' }
          ],
          outputMessages: [{ content: '' }],
          modelName: 'gpt-3.5-turbo-instruct',
          modelProvider: 'openai',
          metadata: { max_tokens: 100, temperature: 0.5, n: 1, stream: false, user: 'dd-trace-test' },
          tags: { ml_app: 'test', integration: 'openai' },
          error: {
            type: 'Error',
            message: error.message,
            stack: error.stack
          }
        })
      })

      it('submits an AzureOpenAI completion', async () => {
        try {
          await azureOpenai.chat.completions.create({
            model: 'gpt-4.1',
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
          // expected error
        }

        const { llmobsSpans } = await getEvents()

        assert.equal(llmobsSpans[0].name, 'AzureOpenAI.createChatCompletion', 'Span event name does not match')
        assert.equal(llmobsSpans[0].meta.model_provider, 'azure_openai', 'Model provider does not match')
      })

      it('submits an DeepSeek completion', async () => {
        await deepseekOpenai.chat.completions.create({
          model: 'deepseek-chat',
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

        const { llmobsSpans } = await getEvents()

        assert.equal(llmobsSpans[0].name, 'DeepSeek.createChatCompletion', 'Span event name does not match')
        assert.equal(llmobsSpans[0].meta.model_provider, 'deepseek', 'Model provider does not match')
      })

      it('submits a chat completion span with cached token metrics', async () => {
        const baseMessages = [{ role: 'system', content: 'You are an expert software engineer '.repeat(200) }]

        await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: baseMessages.concat(
            [
              {
                role: 'user',
                content: 'What are the best practices for API design?'
              }
            ]
          ),
          temperature: 0.5,
          stream: false,
          max_tokens: 100,
          n: 1,
          user: 'dd-trace-test'
        })

        let events = await getEvents()

        assertLlmObsSpanEvent(events.llmobsSpans[0], {
          span: events.apmSpans[0],
          spanKind: 'llm',
          name: 'OpenAI.createChatCompletion',
          inputMessages: baseMessages.concat(
            [
              {
                role: 'user',
                content: 'What are the best practices for API design?'
              }
            ]
          ),
          outputMessages: [
            { role: 'assistant', content: MOCK_STRING }
          ],
          metrics: {
            input_tokens: 1221,
            output_tokens: 100,
            total_tokens: 1321
          },
          modelName: 'gpt-4o',
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

        await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: baseMessages.concat([{ role: 'user', content: 'How should I structure my database schema?' }]),
          temperature: 0.5,
          stream: false,
          max_tokens: 100,
          n: 1,
          user: 'dd-trace-test'
        })

        events = await getEvents()

        assertLlmObsSpanEvent(events.llmobsSpans[0], {
          span: events.apmSpans[0],
          spanKind: 'llm',
          name: 'OpenAI.createChatCompletion',
          inputMessages: baseMessages.concat(
            [
              {
                role: 'user',
                content: 'How should I structure my database schema?'
              }
            ]
          ),
          outputMessages: [
            { role: 'assistant', content: MOCK_STRING }
          ],
          metrics: {
            input_tokens: 1220,
            output_tokens: 100,
            total_tokens: 1320,
            cache_read_input_tokens: 1152,
          },
          modelName: 'gpt-4o',
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
    })
  })
})
