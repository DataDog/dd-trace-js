'use strict'

const { useEnv } = require('../../../../../../integration-tests/helpers')
const chai = require('chai')
const { expect } = chai
const semifies = require('semifies')
const { withVersions } = require('../../../setup/mocha')

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

// ai<4.0.2 is not supported in CommonJS with Node.js < 22
const range = NODE_MAJOR < 22 ? '>=4.0.2' : '>=4.0.0'

function getAiSdkOpenAiPackage (vercelAiVersion) {
  return semifies(vercelAiVersion, '>=5.0.0') ? '@ai-sdk/openai' : '@ai-sdk/openai@1.3.23'
}

describe('Plugin', function () {
  this.timeout(30_000)

  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>',
    _DD_LLMOBS_FLUSH_INTERVAL: 0
  })

  withVersions('ai', 'ai', range, (version, _, realVersion) => {
    let ai
    let openai

    const getEvents = useLlmobs({ plugin: 'ai' })

    beforeEach(function () {
      ai = require(`../../../../../../versions/ai@${version}`).get()

      const OpenAI = require(`../../../../../../versions/${getAiSdkOpenAiPackage(realVersion)}`).get()
      openai = OpenAI.createOpenAI({
        baseURL: 'http://127.0.0.1:9126/vcr/openai',
        compatibility: 'strict'
      })
    })

    it('creates a span for generateText', async () => {
      await ai.generateText({
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxTokens: 100,
        temperature: 0.5
      })

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: apmSpans[0],
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
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
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
      const schema = ai.jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          height: { type: 'string' }
        },
        required: ['name', 'age', 'height']
      })

      await ai.generateObject({
        model: openai('gpt-4o-mini'),
        schema,
        prompt: 'Invent a character for a video game'
      })

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: apmSpans[0],
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
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
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

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: apmSpans[0],
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
        span: apmSpans[1],
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

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: apmSpans[0],
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
        span: apmSpans[1],
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
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxTokens: 100,
        temperature: 0.5
      })

      const textStream = result.textStream

      for await (const part of textStream) {} // eslint-disable-line

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: apmSpans[0],
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
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
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
      const schema = ai.jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          height: { type: 'string' }
        },
        required: ['name', 'age', 'height']
      })

      const result = await ai.streamObject({
        model: openai('gpt-4o-mini'),
        schema,
        prompt: 'Invent a character for a video game'
      })

      const partialObjectStream = result.partialObjectStream

      for await (const part of partialObjectStream) {} // eslint-disable-line

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedCharacter = { name: 'Zara Nightshade', age: 28, height: "5'7\"" }

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: apmSpans[0],
        name: 'streamObject',
        spanKind: 'workflow',
        inputValue: 'Invent a character for a video game',
        outputValue: JSON.stringify(expectedCharacter),
        metadata: {
          schema: MOCK_OBJECT,
          output: 'object',
          maxRetries: MOCK_NUMBER,
        },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' }
      })

      const expectedLlmSpan = expectedLLMObsLLMSpanEvent({
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'doStream',
        inputMessages: [{ content: 'Invent a character for a video game', role: 'user' }],
        outputMessages: [{
          content: JSON.stringify(expectedCharacter),
          role: 'assistant'
        }],
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' }
      })

      expect(llmobsSpans[0]).to.deepEqualWithMockValues(expectedWorkflowSpan)
      expect(llmobsSpans[1]).to.deepEqualWithMockValues(expectedLlmSpan)
    })

    it('creates a span for a tool call', async () => {
      let tools
      let maxStepsArg = {}
      const toolSchema = ai.jsonSchema({
        type: 'object',
        properties: {
          location: { type: 'string', description: 'The location to get the weather for' }
        },
        required: ['location']
      })

      if (semifies(realVersion, '>=5.0.0')) {
        tools = {
          weather: ai.tool({
            description: 'Get the weather in a given location',
            inputSchema: toolSchema,
            execute: async ({ location }) => ({
              location,
              temperature: 72
            })
          })
        }

        maxStepsArg = { stopWhen: ai.stepCountIs(5) }
      } else {
        tools = [ai.tool({
          id: 'weather',
          description: 'Get the weather in a given location',
          parameters: toolSchema,
          execute: async ({ location }) => ({
            location,
            temperature: 72
          })
        })]

        maxStepsArg = { maxSteps: 5 }
      }

      await ai.generateText({
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools,
        ...maxStepsArg,
      })

      const { apmSpans, llmobsSpans } = await getEvents()

      const workflowSpan = llmobsSpans[0]
      const llmSpan = llmobsSpans[1]
      const toolCallSpan = llmobsSpans[2]
      const llmSpan2 = llmobsSpans[3]

      const expectedFinalOutput = semifies(realVersion, '>=5.0.0')
        ? 'The current temperature in Tokyo is 72°F. If you need more details about the weather, just let me know!'
        : 'The current weather in Tokyo is 72°F.'

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: apmSpans[0],
        name: 'generateText',
        spanKind: 'workflow',
        inputValue: 'What is the weather in Tokyo?',
        outputValue: expectedFinalOutput,
        metadata: {
          maxSteps: MOCK_NUMBER,
          maxRetries: MOCK_NUMBER,
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      const expectedLlmSpan = expectedLLMObsLLMSpanEvent({
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
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
            name: 'weather',
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
        span: apmSpans[2],
        parentId: llmobsSpans[0].span_id,
        name: 'weather',
        spanKind: 'tool',
        inputValue: '{"location":"Tokyo"}',
        outputValue: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      const expectedLlmSpan2 = expectedLLMObsLLMSpanEvent({
        span: apmSpans[3],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
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
              name: 'weather',
              arguments: {
                location: 'Tokyo'
              },
              type: 'function'
            }]
          },
          {
            content: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
            role: 'tool',
            tool_id: MOCK_STRING
          }
        ],
        outputMessages: [{ content: expectedFinalOutput, role: 'assistant' }],
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
      let tools
      let maxStepsArg = {}
      const toolSchema = ai.jsonSchema({
        type: 'object',
        properties: {
          location: { type: 'string', description: 'The location to get the weather for' }
        },
        required: ['location']
      })

      if (semifies(realVersion, '>=5.0.0')) {
        tools = {
          weather: ai.tool({
            description: 'Get the weather in a given location',
            inputSchema: toolSchema,
            execute: async ({ location }) => ({
              location,
              temperature: 72
            })
          })
        }

        maxStepsArg = { stopWhen: ai.stepCountIs(5) }
      } else {
        tools = [ai.tool({
          id: 'weather',
          description: 'Get the weather in a given location',
          parameters: toolSchema,
          execute: async ({ location }) => ({
            location,
            temperature: 72
          })
        })]

        maxStepsArg = { maxSteps: 5 }
      }

      const result = await ai.streamText({
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools,
        ...maxStepsArg,
      })

      const textStream = result.textStream

      for await (const part of textStream) {} // eslint-disable-line

      const { apmSpans, llmobsSpans } = await getEvents()

      const workflowSpan = llmobsSpans[0]
      const llmSpan = llmobsSpans[1]
      const toolCallSpan = llmobsSpans[2]
      const llmSpan2 = llmobsSpans[3]

      const expectedFinalOutput = semifies(realVersion, '>=5.0.0')
        ? 'The current temperature in Tokyo is 72°F. If you need more details or specific forecasts, feel free to ask!'
        : 'The current weather in Tokyo is 72°F.'

      const expectedWorkflowSpan = expectedLLMObsNonLLMSpanEvent({
        span: apmSpans[0],
        name: 'streamText',
        spanKind: 'workflow',
        inputValue: 'What is the weather in Tokyo?',
        outputValue: expectedFinalOutput,
        metadata: {
          maxSteps: MOCK_NUMBER,
          maxRetries: MOCK_NUMBER,
        },
        tokenMetrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      const expectedLlmSpan = expectedLLMObsLLMSpanEvent({
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
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
            name: 'weather',
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
        span: apmSpans[2],
        parentId: llmobsSpans[0].span_id,
        /**
         * MOCK_STRING used as the stream implementation for ai does not finish the initial llm spans
         * first to associate the tool call id with the tool itself (by matching descriptions).
         *
         * Usually, this would mean the tool call name is 'toolCall'.
         *
         * However, because we used mocked responses, the second time this test is called, the tool call
         * will have the name 'weather' instead. We just assert that the name exists and is a string to simplify.
         */
        name: MOCK_STRING,
        spanKind: 'tool',
        inputValue: JSON.stringify({ location: 'Tokyo' }),
        outputValue: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
        tags: { ml_app: 'test', language: 'javascript', integration: 'ai' },
      })

      const expectedLlmSpan2 = expectedLLMObsLLMSpanEvent({
        span: apmSpans[3],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
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
              name: 'weather',
              arguments: {
                location: 'Tokyo'
              },
              type: 'function'
            }]
          },
          {
            content: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
            role: 'tool',
            tool_id: MOCK_STRING
          }
        ],
        outputMessages: [{ content: expectedFinalOutput, role: 'assistant' }],
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
