'use strict'

const { useEnv } = require('../../../../../../integration-tests/helpers')
const chai = require('chai')
const { expect } = chai

const semifies = require('semifies')

const { NODE_MAJOR } = require('../../../../../../version')

const {
  expectedLLMObsLLMSpanEvent,
  expectedLLMObsNonLLMSpanEvent,
  deepEqualWithMockValues,
  MOCK_STRING,
  useLlmobs,
  MOCK_NUMBER,
  MOCK_OBJECT
} = require('../../util')

chai.Assertion.addMethod('deepEqualWithMockValues', deepEqualWithMockValues)

describe('Plugin', () => {
  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>'
  })

  withVersions('ai', 'ai', (version, _, moduleVersion) => {
    let ai
    let openai
    let zod

    const getEvents = useLlmobs({ plugin: 'ai' })

    beforeEach(function () {
      if (semifies(moduleVersion, '<4.0.2') && NODE_MAJOR < 22) {
        /**
         * Resolves the following error:
         *
         * Error [ERR_REQUIRE_ESM]: require() of ES Module  from ... not supported.
         */
        this.skip()
      }

      ai = require(`../../../../../../versions/ai@${version}`).get()

      const OpenAI = require('../../../../../../versions/@ai-sdk/openai').get()
      openai = OpenAI.createOpenAI({
        baseURL: 'http://127.0.0.1:9126/vcr/openai'
      })

      zod = require('../../../../../../versions/zod').get()
    })

    it('creates a span for generateText', async () => {
      await ai.generateText({
        model: openai('gpt-3.5-turbo'),
        system: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxTokens: 100,
        temperature: 0.5
      })

      const { spans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: spans[0],
        name: 'generateText',
        spanKind: 'workflow',
        inputValue: 'Hello, OpenAI!',
        outputValue: MOCK_STRING,
        metadata: {
          maxTokens: 100,
          temperature: 0.5,
          maxSteps: MOCK_NUMBER,
          maxRetries: MOCK_NUMBER,
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      const expectedLlmSpan = expectedLLMObsLLMSpanEvent({
        span: spans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-3.5-turbo',
        modelProvider: 'openai',
        name: 'doGenerate',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'Hello, OpenAI!', role: 'user' }
        ],
        outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
        metadata: {
          max_tokens: 100,
          temperature: 0.5,
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      expect(llmobsSpans[0]).to.deepEqualWithMockValues(expectedWorkflowSpan)
      expect(llmobsSpans[1]).to.deepEqualWithMockValues(expectedLlmSpan)
    })

    it('creates a span for generateObject', async () => {
      await ai.generateObject({
        model: openai('gpt-3.5-turbo'),
        schema: zod.object({
          name: zod.string(),
          age: zod.number(),
          height: zod.string()
        }),
        prompt: 'Invent a character for a video game'
      })

      const { spans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: spans[0],
        name: 'generateObject',
        spanKind: 'workflow',
        inputValue: 'Invent a character for a video game',
        outputValue: MOCK_STRING,
        metadata: {
          schema: MOCK_OBJECT,
          output: 'object',
          maxRetries: MOCK_NUMBER,
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      const expectedLlmSpan = expectedLLMObsLLMSpanEvent({
        span: spans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-3.5-turbo',
        modelProvider: 'openai',
        name: 'doGenerate',
        inputMessages: [{ content: 'Invent a character for a video game', role: 'user' }],
        outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' }
      })

      expect(llmobsSpans[0]).to.deepEqualWithMockValues(expectedWorkflowSpan)
      expect(llmobsSpans[1]).to.deepEqualWithMockValues(expectedLlmSpan)
    })

    it('creates a span for embed', async () => {
      await ai.embed({
        model: openai.embedding('text-embedding-ada-002'),
        value: 'hello world'
      })

      const { spans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: spans[0],
        name: 'embed',
        spanKind: 'workflow',
        inputValue: 'hello world',
        outputValue: '[1 embedding(s) returned with size 1536]',
        metadata: {
          maxSteps: MOCK_NUMBER,
          maxRetries: MOCK_NUMBER,
        },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' }
      })

      const expectedEmbeddingSpan = expectedLLMObsLLMSpanEvent({
        span: spans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'embedding',
        modelName: 'text-embedding-ada-002',
        modelProvider: 'openai',
        name: 'doEmbed',
        inputDocuments: [{ text: 'hello world' }],
        outputValue: '[1 embedding(s) returned with size 1536]',
        tokenMetrics: { input_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' }
      })

      expect(llmobsSpans[0]).to.deepEqualWithMockValues(expectedWorkflowSpan)
      expect(llmobsSpans[1]).to.deepEqualWithMockValues(expectedEmbeddingSpan)
    })

    it('creates a span for embedMany', async () => {
      await ai.embedMany({
        model: openai.embedding('text-embedding-ada-002'),
        values: ['hello world', 'goodbye world']
      })

      const { spans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: spans[0],
        name: 'embedMany',
        spanKind: 'workflow',
        inputValue: JSON.stringify(['hello world', 'goodbye world']),
        outputValue: '[2 embedding(s) returned with size 1536]',
        metadata: {
          maxSteps: MOCK_NUMBER,
          maxRetries: MOCK_NUMBER,
        },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' }
      })

      const expectedEmbeddingSpan = expectedLLMObsLLMSpanEvent({
        span: spans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'embedding',
        modelName: 'text-embedding-ada-002',
        modelProvider: 'openai',
        name: 'doEmbed',
        inputDocuments: [{ text: 'hello world' }, { text: 'goodbye world' }],
        outputValue: '[2 embedding(s) returned with size 1536]',
        tokenMetrics: { input_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' }
      })

      expect(llmobsSpans[0]).to.deepEqualWithMockValues(expectedWorkflowSpan)
      expect(llmobsSpans[1]).to.deepEqualWithMockValues(expectedEmbeddingSpan)
    })

    it('creates a span for streamText', async () => {
      const result = await ai.streamText({
        model: openai('gpt-3.5-turbo'),
        system: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxTokens: 100,
        temperature: 0.5
      })

      const textStream = result.textStream

      for await (const part of textStream) {} // eslint-disable-line

      const { spans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: spans[0],
        name: 'streamText',
        spanKind: 'workflow',
        inputValue: 'Hello, OpenAI!',
        outputValue: 'Hello! How can I assist you today?', // assert text from stream is fully captured
        metadata: {
          maxSteps: MOCK_NUMBER,
          maxRetries: MOCK_NUMBER,
        },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' }
      })

      const expectedLlmSpan = expectedLLMObsLLMSpanEvent({
        span: spans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-3.5-turbo',
        modelProvider: 'openai',
        name: 'doStream',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'Hello, OpenAI!', role: 'user' }
        ],
        metadata: {
          max_tokens: 100,
          temperature: 0.5,
        },
        outputMessages: [{ content: 'Hello! How can I assist you today?', role: 'assistant' }],
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' }
      })

      expect(llmobsSpans[0]).to.deepEqualWithMockValues(expectedWorkflowSpan)
      expect(llmobsSpans[1]).to.deepEqualWithMockValues(expectedLlmSpan)
    })

    it('creates a span for streamObject', async () => {
      const result = await ai.streamObject({
        model: openai('gpt-3.5-turbo'),
        schema: zod.object({
          name: zod.string(),
          age: zod.number(),
          height: zod.string()
        }),
        prompt: 'Invent a character for a video game'
      })

      const partialObjectStream = result.partialObjectStream

      for await (const part of partialObjectStream) {} // eslint-disable-line

      const { spans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: spans[0],
        name: 'streamObject',
        spanKind: 'workflow',
        inputValue: 'Invent a character for a video game',
        outputValue: JSON.stringify({ name: 'Astra', age: 25, height: '5\'8"' }),
        metadata: {
          schema: MOCK_OBJECT,
          output: 'object',
          maxRetries: MOCK_NUMBER,
        },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' }
      })

      const expectedLlmSpan = expectedLLMObsLLMSpanEvent({
        span: spans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-3.5-turbo',
        modelProvider: 'openai',
        name: 'doStream',
        inputMessages: [{ content: 'Invent a character for a video game', role: 'user' }],
        outputMessages: [{ content: JSON.stringify({ name: 'Astra', age: 25, height: '5\'8"' }), role: 'assistant' }],
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' }
      })

      expect(llmobsSpans[0]).to.deepEqualWithMockValues(expectedWorkflowSpan)
      expect(llmobsSpans[1]).to.deepEqualWithMockValues(expectedLlmSpan)
    })

    it('creates a span for a tool call', async () => {
      const getWeather = ai.tool({
        id: 'get_weather',
        description: 'Get the weather in a given location',
        parameters: zod.object({
          location: zod.string()
        }),
        execute: async ({ location }) => `It is nice and sunny in ${location}.`
      })

      await ai.generateText({
        model: openai('gpt-3.5-turbo'),
        system: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools: [getWeather],
        maxSteps: 2,
      })

      const { spans, llmobsSpans } = await getEvents()

      const workflowSpan = llmobsSpans[0]
      const llmSpan = llmobsSpans[1]
      const toolCallSpan = llmobsSpans[2]
      const llmSpan2 = llmobsSpans[3]

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: spans[0],
        name: 'generateText',
        spanKind: 'workflow',
        inputValue: 'What is the weather in Tokyo?',
        outputValue: 'The weather in Tokyo is nice and sunny.',
        metadata: {
          maxSteps: MOCK_NUMBER,
          maxRetries: MOCK_NUMBER,
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      const expectedLlmSpan = expectedLLMObsLLMSpanEvent({
        span: spans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-3.5-turbo',
        modelProvider: 'openai',
        name: 'doGenerate',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is the weather in Tokyo?', role: 'user' }
        ],
        outputMessages: [{
          content: MOCK_STRING,
          role: 'assistant',
          tool_calls: [{
            tool_id: MOCK_STRING,
            name: 'get_weather',
            arguments: {
              location: 'Tokyo'
            },
            type: 'function'
          }]
        }],
        metadata: {
          max_tokens: 100,
          temperature: 0.5,
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      const expectedToolCallSpan = expectedLLMObsNonLLMSpanEvent({
        span: spans[2],
        parentId: llmobsSpans[0].span_id,
        name: 'get_weather',
        spanKind: 'tool',
        inputValue: '{"location":"Tokyo"}',
        outputValue: 'It is nice and sunny in Tokyo.',
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      const expectedLlmSpan2 = expectedLLMObsLLMSpanEvent({
        span: spans[3],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-3.5-turbo',
        modelProvider: 'openai',
        name: 'doGenerate',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is the weather in Tokyo?', role: 'user' },
          {
            content: '',
            role: 'assistant',
            tool_calls: [{
              tool_id: MOCK_STRING,
              name: 'get_weather',
              arguments: {
                location: 'Tokyo'
              },
              type: 'function'
            }]
          },
          {
            content: 'It is nice and sunny in Tokyo.',
            role: 'tool',
            tool_id: MOCK_STRING
          }
        ],
        outputMessages: [{ content: 'The weather in Tokyo is nice and sunny.', role: 'assistant' }],
        metadata: {
          max_tokens: 100,
          temperature: 0.5,
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      expect(workflowSpan).to.deepEqualWithMockValues(expectedWorkflowSpan)
      expect(llmSpan).to.deepEqualWithMockValues(expectedLlmSpan)
      expect(toolCallSpan).to.deepEqualWithMockValues(expectedToolCallSpan)
      expect(llmSpan2).to.deepEqualWithMockValues(expectedLlmSpan2)
    })

    it('created a span for a tool call from a stream', async () => {
      const getWeather = ai.tool({
        id: 'get_weather',
        description: 'Get the weather in a given location',
        parameters: zod.object({
          location: zod.string()
        }),
        execute: async ({ location }) => `It is nice and sunny in ${location}.`
      })

      const result = await ai.streamText({
        model: openai('gpt-3.5-turbo'),
        system: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools: [getWeather],
        maxSteps: 2,
      })

      const textStream = result.textStream

      for await (const part of textStream) {} // eslint-disable-line

      const { spans, llmobsSpans } = await getEvents()

      const workflowSpan = llmobsSpans[0]
      const llmSpan = llmobsSpans[1]
      const toolCallSpan = llmobsSpans[2]
      const llmSpan2 = llmobsSpans[3]

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: spans[0],
        name: 'streamText',
        spanKind: 'workflow',
        inputValue: 'What is the weather in Tokyo?',
        outputValue: 'The weather in Tokyo is nice and sunny.',
        metadata: {
          maxSteps: MOCK_NUMBER,
          maxRetries: MOCK_NUMBER,
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      const expectedLlmSpan = expectedLLMObsLLMSpanEvent({
        span: spans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-3.5-turbo',
        modelProvider: 'openai',
        name: 'doStream',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is the weather in Tokyo?', role: 'user' }
        ],
        outputMessages: [{
          content: MOCK_STRING,
          role: 'assistant',
          tool_calls: [{
            tool_id: MOCK_STRING,
            name: 'get_weather',
            arguments: {
              location: 'Tokyo'
            },
            type: 'function'
          }]
        }],
        metadata: {
          max_tokens: 100,
          temperature: 0.5,
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      const expectedToolCallSpan = expectedLLMObsNonLLMSpanEvent({
        span: spans[2],
        parentId: llmobsSpans[0].span_id,
        /**
         * MOCK_STRING used as the stream implementation for ai does not finish the initial llm spans
         * first to associate the tool call id with the tool itself (by matching descriptions).
         *
         * Usually, this would mean the tool call name is 'toolCall'.
         *
         * However, because we used mocked responses, the second time this test is called, the tool call
         * will have the name 'get_weather' instead. We just assert that the name exists and is a string to simplify.
         */
        name: MOCK_STRING,
        spanKind: 'tool',
        inputValue: '{"location":"Tokyo"}',
        outputValue: 'It is nice and sunny in Tokyo.',
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      const expectedLlmSpan2 = expectedLLMObsLLMSpanEvent({
        span: spans[3],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-3.5-turbo',
        modelProvider: 'openai',
        name: 'doStream',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is the weather in Tokyo?', role: 'user' },
          {
            content: '',
            role: 'assistant',
            tool_calls: [{
              tool_id: MOCK_STRING,
              name: 'get_weather',
              arguments: {
                location: 'Tokyo'
              },
              type: 'function'
            }]
          },
          {
            content: 'It is nice and sunny in Tokyo.',
            role: 'tool',
            tool_id: MOCK_STRING
          }
        ],
        outputMessages: [{ content: 'The weather in Tokyo is nice and sunny.', role: 'assistant' }],
        metadata: {
          max_tokens: 100,
          temperature: 0.5,
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      expect(workflowSpan).to.deepEqualWithMockValues(expectedWorkflowSpan)
      expect(llmSpan).to.deepEqualWithMockValues(expectedLlmSpan)
      expect(toolCallSpan).to.deepEqualWithMockValues(expectedToolCallSpan)
      expect(llmSpan2).to.deepEqualWithMockValues(expectedLlmSpan2)
    })
  })
})
