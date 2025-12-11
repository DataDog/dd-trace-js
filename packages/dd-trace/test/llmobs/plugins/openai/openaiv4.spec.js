'use strict'

const { describe, it, beforeEach } = require('mocha')
const semifies = require('semifies')

const { withVersions } = require('../../../setup/mocha')

const {
  useLlmObs,
  assertLlmObsSpanEvent,
  assertPromptTracking,
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
            { content: 'Hello, OpenAI!', role: '' }
          ],
          outputMessages: [
            { content: MOCK_STRING, role: '' }
          ],
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
          modelName: 'gpt-3.5-turbo-instruct:20230824-v2',
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
          metrics: {
            cache_read_input_tokens: 0,
            input_tokens: MOCK_NUMBER,
            output_tokens: MOCK_NUMBER,
            total_tokens: MOCK_NUMBER
          },
          modelName: 'gpt-3.5-turbo-0125',
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
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: 0, total_tokens: MOCK_NUMBER },
          modelName: 'text-embedding-ada-002-v2',
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
          modelName: 'gpt-3.5-turbo-0125',
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
          metrics: {
            cache_read_input_tokens: 0,
            input_tokens: MOCK_NUMBER,
            output_tokens: MOCK_NUMBER,
            total_tokens: MOCK_NUMBER
          }
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
            // last chunk will have no choices, but a usage block instead
            if (part.choices.length > 0) {
              assert.ok(part.choices[0].text != null, 'Expected chunk delta to be truthy')
            } else {
              assert.ok(part.usage, 'Expected usage to be truthy')
            }
          }

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'OpenAI.createCompletion',
            inputMessages: [
              { content: 'Hello, OpenAI!', role: '' }
            ],
            outputMessages: [
              { content: '\n\nHello! How can I assist you?', role: '' }
            ],
            metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
            modelName: 'gpt-3.5-turbo-instruct:20230824-v2',
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
            // last chunk will have no choices, but a usage block instead
            if (part.choices.length > 0) {
              assert.ok(part.choices[0].delta != null, 'Expected chunk delta to be truthy')
            } else {
              assert.ok(part.usage, 'Expected usage to be truthy')
            }
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
            metrics: {
              cache_read_input_tokens: 0,
              input_tokens: MOCK_NUMBER,
              output_tokens: MOCK_NUMBER,
              total_tokens: MOCK_NUMBER
            },
            modelName: 'gpt-3.5-turbo-0125',
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
            // last chunk will have no choices, but a usage block instead
            if (part.choices.length > 0) {
              assert.ok(part.choices[0].delta != null, 'Expected chunk delta to be truthy')
            } else {
              assert.ok(part.usage, 'Expected usage to be truthy')
            }
          }

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLlmObsSpanEvent(llmobsSpans[0], {
            span: apmSpans[0],
            spanKind: 'llm',
            name: 'OpenAI.createChatCompletion',
            modelName: 'gpt-3.5-turbo-0125',
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
            metrics: {
              cache_read_input_tokens: 0,
              input_tokens: MOCK_NUMBER,
              output_tokens: MOCK_NUMBER,
              total_tokens: MOCK_NUMBER
            }
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
          inputMessages: [{ content: 'Hello, OpenAI!', role: '' }],
          outputMessages: [{ content: '', role: '' }],
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

      it('submits a chat completion span with an error', async () => {
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
          outputMessages: [{ content: '', role: '' }],
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
            cache_read_input_tokens: 0,
            input_tokens: 1221,
            output_tokens: 100,
            total_tokens: 1321
          },
          modelName: 'gpt-4o-2024-08-06',
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
          modelName: 'gpt-4o-2024-08-06',
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

      it('submits a response span', async function () {
        if (semifies(realVersion, '<4.87.0')) {
          this.skip()
        }

        await openai.responses.create({
          model: 'gpt-4o-mini',
          input: 'What is the capital of France?',
          max_output_tokens: 100,
          temperature: 0.5,
          stream: false
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'OpenAI.createResponse',
          inputMessages: [
            { role: 'user', content: 'What is the capital of France?' }
          ],
          outputMessages: [
            { role: 'assistant', content: MOCK_STRING }
          ],
          metrics: {
            input_tokens: MOCK_NUMBER,
            output_tokens: MOCK_NUMBER,
            total_tokens: MOCK_NUMBER,
            cache_read_input_tokens: 0
          },
          modelName: 'gpt-4o-mini-2024-07-18',
          modelProvider: 'openai',
          metadata: {
            max_output_tokens: 100,
            temperature: 0.5,
            top_p: 1,
            tool_choice: 'auto',
            truncation: 'disabled',
            text: { format: { type: 'text' }, verbosity: 'medium' },
            reasoning_tokens: 0,
            stream: false
          },
          tags: { ml_app: 'test', integration: 'openai' }
        })
      })

      it('submits a streamed response span', async function () {
        if (semifies(realVersion, '<4.87.0')) {
          this.skip()
        }

        const stream = await openai.responses.create({
          model: 'gpt-4o-mini',
          input: 'Stream this please',
          max_output_tokens: 50,
          temperature: 0,
          stream: true
        })

        for await (const part of stream) {
          assert.ok(Object.hasOwn(part, 'type'))
        }

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'OpenAI.createResponse',
          inputMessages: [
            { role: 'user', content: 'Stream this please' }
          ],
          outputMessages: [
            { role: 'assistant', content: MOCK_STRING }
          ],
          metrics: {
            input_tokens: MOCK_NUMBER,
            output_tokens: MOCK_NUMBER,
            total_tokens: MOCK_NUMBER,
            cache_read_input_tokens: 0
          },
          modelName: 'gpt-4o-mini-2024-07-18',
          modelProvider: 'openai',
          metadata: {
            max_output_tokens: 50,
            temperature: 0,
            top_p: 1,
            tool_choice: 'auto',
            truncation: 'disabled',
            text: { format: { type: 'text' }, verbosity: 'medium' },
            reasoning_tokens: 0,
            stream: true
          },
          tags: { ml_app: 'test', integration: 'openai' }
        })
      })

      describe('prompts', function () {
        beforeEach(function () {
          if (semifies(realVersion, '<4.87.0')) {
            this.skip()
          }
        })

        it('submits a response span with prompt tracking - overlapping values', async function () {
          await openai.responses.create({
            prompt: {
              id: 'pmpt_6911a8b8f7648197b39bd62127a696910d4a05830d5ba1e6',
              version: '1',
              variables: { phrase: 'cat in the hat', word: 'cat' }
            }
          })

          const { llmobsSpans } = await getEvents()

          assertPromptTracking(llmobsSpans[0], {
            id: 'pmpt_6911a8b8f7648197b39bd62127a696910d4a05830d5ba1e6',
            version: '1',
            variables: { phrase: 'cat in the hat', word: 'cat' },
            chat_template: [
              { role: 'user', content: 'I saw a {{phrase}} and another {{word}}' }
            ]
          }, [
            { role: 'user', content: 'I saw a cat in the hat and another cat' }
          ])
        })

        it('submits a response span with prompt tracking - partial word match', async function () {
          await openai.responses.create({
            prompt: {
              id: 'pmpt_6911a954c8988190a82b11560faa47cd0d6629899573dd8f',
              version: '2',
              variables: { word: 'test' }
            }
          })

          const { llmobsSpans } = await getEvents()

          assertPromptTracking(llmobsSpans[0], {
            id: 'pmpt_6911a954c8988190a82b11560faa47cd0d6629899573dd8f',
            version: '2',
            variables: { word: 'test' },
            chat_template: [
              { role: 'developer', content: 'Reply with "OK".' },
              { role: 'user', content: 'This is a {{word}} for {{word}}ing the {{word}}er' }
            ]
          }, [
            { role: 'developer', content: 'Reply with "OK".' },
            { role: 'user', content: 'This is a test for testing the tester' }
          ])
        })

        it('submits a response span with prompt tracking - special characters', async function () {
          await openai.responses.create({
            prompt: {
              id: 'pmpt_6911a99a3eec81959d5f2e408a2654380b2b15731a51f191',
              version: '2',
              variables: { price: '$99.99', item: 'groceries' }
            }
          })

          const { llmobsSpans } = await getEvents()

          assertPromptTracking(llmobsSpans[0], {
            id: 'pmpt_6911a99a3eec81959d5f2e408a2654380b2b15731a51f191',
            version: '2',
            variables: { price: '$99.99', item: 'groceries' },
            chat_template: [
              { role: 'user', content: 'The price of {{item}} is {{price}}.' }
            ]
          }, [
            { role: 'user', content: 'The price of groceries is $99.99.' }
          ])
        })

        it('submits a response span with prompt tracking - empty values', async function () {
          await openai.responses.create({
            prompt: {
              id: 'pmpt_6911a8b8f7648197b39bd62127a696910d4a05830d5ba1e6',
              version: '1',
              variables: { phrase: 'cat in the hat', word: '' }
            }
          })

          const { llmobsSpans } = await getEvents()

          assertPromptTracking(llmobsSpans[0], {
            id: 'pmpt_6911a8b8f7648197b39bd62127a696910d4a05830d5ba1e6',
            version: '1',
            variables: { phrase: 'cat in the hat', word: '' },
            chat_template: [
              { role: 'user', content: 'I saw a {{phrase}} and another ' }
            ]
          }, [
            { role: 'user', content: 'I saw a cat in the hat and another ' }
          ])
        })

        it('submits a response span with prompt tracking - mixed input types (url stripped)', async function () {
          await openai.responses.create({
            prompt: {
              id: 'pmpt_69201db75c4c81959c01ea6987ab023c070192cd2843dec0',
              version: '2',
              variables: {
                user_message: { type: 'input_text', text: 'Analyze these images and document' },
                user_image_1: { type: 'input_image', image_url: 'https://raw.githubusercontent.com/github/explore/main/topics/python/python.png', detail: 'auto' },
                user_file: { type: 'input_file', file_url: 'https://www.berkshirehathaway.com/letters/2024ltr.pdf' },
                user_image_2: { type: 'input_image', file_id: 'file-BCuhT1HQ24kmtsuuzF1mh2', detail: 'auto' }
              }
            }
          })

          const { llmobsSpans } = await getEvents()

          assertPromptTracking(llmobsSpans[0], {
            id: 'pmpt_69201db75c4c81959c01ea6987ab023c070192cd2843dec0',
            version: '2',
            variables: {
              user_message: 'Analyze these images and document',
              user_image_1: 'https://raw.githubusercontent.com/github/explore/main/topics/python/python.png',
              user_file: 'https://www.berkshirehathaway.com/letters/2024ltr.pdf',
              user_image_2: 'file-BCuhT1HQ24kmtsuuzF1mh2'
            },
            chat_template: [
              {
                role: 'user',
                content: 'Analyze the following content from the user:\n\n' +
                  'Text message: {{user_message}}\n' +
                  'Image reference 1: [image]\n' +
                  'Document reference: {{user_file}}\n' +
                  'Image reference 2: {{user_image_2}}\n\n' +
                  'Please provide a comprehensive analysis.'
              }
            ]
          }, [
            {
              role: 'user',
              content: 'Analyze the following content from the user:\n\n' +
                'Text message: Analyze these images and document\n' +
                'Image reference 1: [image]\n' +
                'Document reference: https://www.berkshirehathaway.com/letters/2024ltr.pdf\n' +
                'Image reference 2: file-BCuhT1HQ24kmtsuuzF1mh2\n\n' +
                'Please provide a comprehensive analysis.'
            }
          ])
        })

        it('submits a response span with prompt tracking - mixed input types (url preserved)', async function () {
          await openai.responses.create({
            include: ['message.input_image.image_url'],
            prompt: {
              id: 'pmpt_69201db75c4c81959c01ea6987ab023c070192cd2843dec0',
              version: '2',
              variables: {
                user_message: { type: 'input_text', text: 'Analyze these images and document' },
                user_image_1: { type: 'input_image', image_url: 'https://raw.githubusercontent.com/github/explore/main/topics/python/python.png', detail: 'auto' },
                user_file: { type: 'input_file', file_url: 'https://www.berkshirehathaway.com/letters/2024ltr.pdf' },
                user_image_2: { type: 'input_image', file_id: 'file-BCuhT1HQ24kmtsuuzF1mh2', detail: 'auto' }
              }
            }
          })

          const { llmobsSpans } = await getEvents()

          assertPromptTracking(llmobsSpans[0], {
            id: 'pmpt_69201db75c4c81959c01ea6987ab023c070192cd2843dec0',
            version: '2',
            variables: {
              user_message: 'Analyze these images and document',
              user_image_1: 'https://raw.githubusercontent.com/github/explore/main/topics/python/python.png',
              user_file: 'https://www.berkshirehathaway.com/letters/2024ltr.pdf',
              user_image_2: 'file-BCuhT1HQ24kmtsuuzF1mh2'
            },
            chat_template: [
              {
                role: 'user',
                content: 'Analyze the following content from the user:\n\n' +
                  'Text message: {{user_message}}\n' +
                  'Image reference 1: {{user_image_1}}\n' +
                  'Document reference: {{user_file}}\n' +
                  'Image reference 2: {{user_image_2}}\n\n' +
                  'Please provide a comprehensive analysis.'
              }
            ]
          }, [
            {
              role: 'user',
              content: 'Analyze the following content from the user:\n\n' +
                'Text message: Analyze these images and document\n' +
                'Image reference 1: https://raw.githubusercontent.com/github/explore/main/topics/python/python.png\n' +
                'Document reference: https://www.berkshirehathaway.com/letters/2024ltr.pdf\n' +
                'Image reference 2: file-BCuhT1HQ24kmtsuuzF1mh2\n\n' +
                'Please provide a comprehensive analysis.'
            }
          ])
        })
      })
    })
  })
})
