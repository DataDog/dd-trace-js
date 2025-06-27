'use strict'

const { useEnv } = require('../../../../../../integration-tests/helpers')
const chai = require('chai')
const { expect } = chai

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

  withVersions('ai', 'ai', version => {
    let ai
    let openai
    let zod

    const getEvents = useLlmobs({ plugin: 'ai' })

    beforeEach(() => {
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
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'vercel-ai' },
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
        tags: { ml_app: 'test', language: 'javascript', integration: 'vercel-ai' },
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
          schema: MOCK_OBJECT
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'vercel-ai' },
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
        tags: { ml_app: 'test', language: 'javascript', integration: 'vercel-ai' },
        metadata: {}
      })

      expect(llmobsSpans[0]).to.deepEqualWithMockValues(expectedWorkflowSpan)
      expect(llmobsSpans[1]).to.deepEqualWithMockValues(expectedLlmSpan)
    })

    it.skip('creates a span for embed', async () => {
      await ai.embed({
        model: openai.embedding('text-embedding-ada-002'),
        value: 'hello world'
      })
    })

    it.skip('creates a span for embedMany', async () => {
      await ai.embedMany({
        model: openai.embedding('text-embedding-ada-002'),
        values: ['hello world', 'goodbye world']
      })
    })

    it.skip('creates a span for streamText', async () => {
      const result = await ai.streamText({
        model: openai('gpt-3.5-turbo'),
        system: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxTokens: 100,
        temperature: 0.5
      })

      const textStream = result.textStream

      for await (const part of textStream) {} // eslint-disable-line
    })

    it.skip('creates a span for streamObject', async () => {
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
          maxSteps: 2,
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'vercel-ai' },
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
        tags: { ml_app: 'test', language: 'javascript', integration: 'vercel-ai' },
      })

      const expectedToolCallSpan = expectedLLMObsNonLLMSpanEvent({
        span: spans[2],
        parentId: llmobsSpans[0].span_id,
        name: 'get_weather',
        spanKind: 'tool',
        inputValue: '{"location":"Tokyo"}',
        outputValue: 'It is nice and sunny in Tokyo.',
        tags: { ml_app: 'test', language: 'javascript', integration: 'vercel-ai' },
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
          }
        ],
        outputMessages: [{ content: 'The weather in Tokyo is nice and sunny.', role: 'assistant' }],
        metadata: {
          max_tokens: 100,
          temperature: 0.5,
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'vercel-ai' },
      })

      expect(workflowSpan).to.deepEqualWithMockValues(expectedWorkflowSpan)
      expect(llmSpan).to.deepEqualWithMockValues(expectedLlmSpan)
      expect(toolCallSpan).to.deepEqualWithMockValues(expectedToolCallSpan)
      expect(llmSpan2).to.deepEqualWithMockValues(expectedLlmSpan2)
    })
  })
})
