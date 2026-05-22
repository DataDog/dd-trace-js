'use strict'

const assert = require('node:assert/strict')

const semifies = require('semifies')
const { useEnv } = require('../../../../../../integration-tests/helpers')
const { withVersions } = require('../../../setup/mocha')
const iastFilter = require('../../../../src/appsec/iast/taint-tracking/filter')

const { NODE_MAJOR } = require('../../../../../../version')

const isDdTrace = iastFilter.isDdTrace

const {
  assertLlmObsSpanEvent,
  MOCK_STRING,
  useLlmObs,
  MOCK_NUMBER,
  MOCK_OBJECT,
} = require('../../util')

// ai<4.0.2 is not supported in CommonJS with Node.js < 22
const range = NODE_MAJOR < 22 ? '>=4.0.2' : '>=4.0.0'

function getAiSdkOpenAiPackage (vercelAiVersion) {
  if (semifies(vercelAiVersion, '>=6.0.0')) {
    return '@ai-sdk/openai'
  } else if (semifies(vercelAiVersion, '>=5.0.0')) {
    return '@ai-sdk/openai@2.0.0'
  } else {
    return '@ai-sdk/openai@1.3.23'
  }
}

function getAiSdkBedrockPackage (vercelAiVersion) {
  if (semifies(vercelAiVersion, '>=6.0.0')) {
    return '@ai-sdk/amazon-bedrock'
  } else if (semifies(vercelAiVersion, '>=5.0.0')) {
    return '@ai-sdk/amazon-bedrock@3.0.0'
  }
  return null
}

function getAiSdkAnthropicPackage (vercelAiVersion) {
  if (semifies(vercelAiVersion, '>=6.0.0')) {
    return '@ai-sdk/anthropic'
  } else if (semifies(vercelAiVersion, '>=5.0.0')) {
    return '@ai-sdk/anthropic@2.0.0'
  } else if (semifies(vercelAiVersion, '>=4.0.0')) {
    return '@ai-sdk/anthropic@1.0.0'
  }
  return null
}

function getAiSdkGooglePackage (vercelAiVersion) {
  if (semifies(vercelAiVersion, '>=6.0.0')) {
    return '@ai-sdk/google'
  } else if (semifies(vercelAiVersion, '>=5.0.0')) {
    return '@ai-sdk/google@2.0.0'
  } else if (semifies(vercelAiVersion, '>=4.0.0')) {
    return '@ai-sdk/google@1.0.0'
  }
  return null
}

const MOCK_TELEMETRY_METADATA = {
  userId: '12345',
  organizationId: 'orgAbc123',
  conversationId: 'convAbc123',
}

describe('Plugin', () => {
  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>',
  })

  const { getEvents } = useLlmObs({ plugin: 'ai' })

  before(async () => {
    iastFilter.isDdTrace = file => {
      if (file.includes('dd-trace-js/versions/')) {
        return false
      }
      return isDdTrace(file)
    }
  })

  after(() => {
    iastFilter.isDdTrace = isDdTrace
  })

  withVersions('ai', 'ai', range, (version, _, realVersion) => {
    let ai
    let openai
    let openaiVersion

    beforeEach(function () {
      ai = require(`../../../../../../versions/ai@${version}`).get()

      const OpenAIModule = require(`../../../../../../versions/${getAiSdkOpenAiPackage(realVersion)}`)
      openaiVersion = OpenAIModule.version()
      const OpenAI = OpenAIModule.get()
      openai = OpenAI.createOpenAI({
        baseURL: 'http://127.0.0.1:9126/vcr/openai',
        compatibility: 'strict',
      })
    })

    it('creates a span for generateText', async () => {
      const options = {
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        temperature: 0.5,
        experimental_telemetry: {
          metadata: MOCK_TELEMETRY_METADATA,
        },
      }

      if (semifies(realVersion, '>=5.0.0')) {
        options.maxOutputTokens = 100
      } else {
        options.maxTokens = 100
      }

      await ai.generateText(options)

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedWorkflowMetadata = {
        ...MOCK_TELEMETRY_METADATA,
      }
      if (semifies(realVersion, '>=5.0.0')) {
        expectedWorkflowMetadata.maxRetries = MOCK_NUMBER
        expectedWorkflowMetadata.maxOutputTokens = 100
      } else {
        expectedWorkflowMetadata.maxSteps = MOCK_NUMBER
      }

      assertLlmObsSpanEvent(llmobsSpans[0], {
        span: apmSpans[0],
        name: 'generateText',
        spanKind: 'workflow',
        inputValue: 'Hello, OpenAI!',
        outputValue: MOCK_STRING,
        metadata: expectedWorkflowMetadata,
        tags: { ml_app: 'test', integration: 'ai' },
      })
      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'doGenerate',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'Hello, OpenAI!', role: 'user' },
        ],
        outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
        metadata: {
          max_tokens: 100,
          temperature: 0.5,
          ...MOCK_TELEMETRY_METADATA,
        },
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it('creates a span for generateObject', async () => {
      const schema = ai.jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          height: { type: 'string' },
        },
        required: ['name', 'age', 'height'],
        additionalProperties: false,
      })

      await ai.generateObject({
        model: openai('gpt-4o-mini'),
        schema,
        prompt: 'Invent a character for a video game',
        experimental_telemetry: {
          metadata: MOCK_TELEMETRY_METADATA,
        },
      })

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedWorkflowMetadata = {
        schema: MOCK_OBJECT,
        output: 'object',
        ...MOCK_TELEMETRY_METADATA,
      }
      if (semifies(realVersion, '>=5.0.0')) {
        expectedWorkflowMetadata.maxRetries = MOCK_NUMBER
      }

      assertLlmObsSpanEvent(llmobsSpans[0], {
        span: apmSpans[0],
        name: 'generateObject',
        spanKind: 'workflow',
        inputValue: 'Invent a character for a video game',
        outputValue: MOCK_STRING,
        metadata: expectedWorkflowMetadata,
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'doGenerate',
        inputMessages: [{ content: 'Invent a character for a video game', role: 'user' }],
        outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        metadata: MOCK_TELEMETRY_METADATA,
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it('creates a span for embed', async () => {
      await ai.embed({
        model: openai.embedding('text-embedding-ada-002'),
        value: 'hello world',
        experimental_telemetry: {
          metadata: MOCK_TELEMETRY_METADATA,
        },
      })

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpanEvent = {
        span: apmSpans[0],
        name: 'embed',
        spanKind: 'workflow',
        inputValue: 'hello world',
        outputValue: '[1 embedding(s) returned with size 1536]',
        metadata: {
          ...MOCK_TELEMETRY_METADATA,
        },
        tags: { ml_app: 'test', integration: 'ai' },
      }

      if (semifies(realVersion, '>=5.0.0')) {
        expectedWorkflowSpanEvent.metadata.maxRetries = MOCK_NUMBER
      }

      assertLlmObsSpanEvent(llmobsSpans[0], expectedWorkflowSpanEvent)

      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'embedding',
        modelName: 'text-embedding-ada-002',
        modelProvider: 'openai',
        name: 'doEmbed',
        inputDocuments: [{ text: 'hello world' }],
        outputValue: '[1 embedding(s) returned with size 1536]',
        metrics: { input_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        metadata: MOCK_TELEMETRY_METADATA,
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it('creates a span for embedMany', async () => {
      await ai.embedMany({
        model: openai.embedding('text-embedding-ada-002'),
        values: ['hello world', 'goodbye world'],
        experimental_telemetry: {
          metadata: {
            userId: '12345',
            organizationId: 'orgAbc123',
            conversationId: 'convAbc123',
          },
        },
      })

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpanEvent = {
        span: apmSpans[0],
        name: 'embedMany',
        spanKind: 'workflow',
        inputValue: JSON.stringify(['hello world', 'goodbye world']),
        outputValue: '[2 embedding(s) returned with size 1536]',
        tags: { ml_app: 'test', integration: 'ai' },
        metadata: {
          userId: '12345',
          organizationId: 'orgAbc123',
          conversationId: 'convAbc123',
        },
      }
      if (semifies(realVersion, '>=5.0.0')) {
        expectedWorkflowSpanEvent.metadata.maxRetries = MOCK_NUMBER
      }

      assertLlmObsSpanEvent(llmobsSpans[0], expectedWorkflowSpanEvent)

      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'embedding',
        modelName: 'text-embedding-ada-002',
        modelProvider: 'openai',
        name: 'doEmbed',
        inputDocuments: [{ text: 'hello world' }, { text: 'goodbye world' }],
        outputValue: '[2 embedding(s) returned with size 1536]',
        metrics: { input_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        metadata: {
          userId: '12345',
          organizationId: 'orgAbc123',
          conversationId: 'convAbc123',
        },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it('creates a span for streamText', async () => {
      const options = {
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxTokens: 100,
        temperature: 0.5,
        experimental_telemetry: {
          metadata: MOCK_TELEMETRY_METADATA,
        },
      }
      if (semifies(realVersion, '>=5.0.0')) {
        options.maxOutputTokens = 100
      } else {
        options.maxTokens = 100
      }
      const result = await ai.streamText(options)

      const textStream = result.textStream

      for await (const part of textStream) {} // eslint-disable-line

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedMetadata =
        semifies(realVersion, '>=5.0.0')
          ? { maxRetries: MOCK_NUMBER, maxOutputTokens: 100 }
          : { maxSteps: MOCK_NUMBER }

      Object.assign(expectedMetadata, MOCK_TELEMETRY_METADATA)

      assertLlmObsSpanEvent(llmobsSpans[0], {
        span: apmSpans[0],
        name: 'streamText',
        spanKind: 'workflow',
        inputValue: 'Hello, OpenAI!',
        outputValue: 'Hello! How can I assist you today?', // assert text from stream is fully captured
        metadata: expectedMetadata,
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'doStream',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'Hello, OpenAI!', role: 'user' },
        ],
        outputMessages: [{ content: 'Hello! How can I assist you today?', role: 'assistant' }],
        metadata: {
          max_tokens: 100,
          temperature: 0.5,
          ...MOCK_TELEMETRY_METADATA,
        },
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it('creates a span for streamObject', async () => {
      const schema = ai.jsonSchema({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          height: { type: 'string' },
        },
        required: ['name', 'age', 'height'],
        additionalProperties: false,
      })

      const result = await ai.streamObject({
        model: openai('gpt-4o-mini'),
        schema,
        prompt: 'Invent a character for a video game',
        experimental_telemetry: {
          metadata: MOCK_TELEMETRY_METADATA,
        },
      })

      const partialObjectStream = result.partialObjectStream

      for await (const part of partialObjectStream) {} // eslint-disable-line

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedCharacter = { name: 'Zara Windrider', age: 28, height: "5'7\"" }

      const expectedWorkflowMetadata = {
        schema: MOCK_OBJECT,
        output: 'object',
        ...MOCK_TELEMETRY_METADATA,
      }
      if (semifies(realVersion, '>=5.0.0')) {
        expectedWorkflowMetadata.maxRetries = MOCK_NUMBER
      }

      assertLlmObsSpanEvent(llmobsSpans[0], {
        span: apmSpans[0],
        name: 'streamObject',
        spanKind: 'workflow',
        inputValue: 'Invent a character for a video game',
        outputValue: JSON.stringify(expectedCharacter),
        metadata: expectedWorkflowMetadata,
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'doStream',
        inputMessages: [{ content: 'Invent a character for a video game', role: 'user' }],
        outputMessages: [{
          content: JSON.stringify(expectedCharacter),
          role: 'assistant',
        }],
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        metadata: MOCK_TELEMETRY_METADATA,
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it('creates a span for a tool call', async () => {
      let tools
      let additionalOptions
      const toolSchema = ai.jsonSchema({
        type: 'object',
        properties: {
          location: { type: 'string', description: 'The location to get the weather for' },
        },
        required: ['location'],
      })

      if (semifies(realVersion, '>=5.0.0')) {
        tools = {
          weather: ai.tool({
            description: 'Get the weather in a given location',
            inputSchema: toolSchema,
            execute: async ({ location }) => ({
              location,
              temperature: 72,
            }),
          }),
        }

        additionalOptions = { stopWhen: ai.stepCountIs(5) }
      } else {
        tools = [ai.tool({
          id: 'weather',
          description: 'Get the weather in a given location',
          parameters: toolSchema,
          execute: async ({ location }) => ({
            location,
            temperature: 72,
          }),
        })]

        additionalOptions = { maxSteps: 5 }
      }

      if (semifies(openaiVersion, '>=2.0.50')) {
        additionalOptions.providerOptions = {
          openai: {
            store: false,
          },
        }
      }

      const result = await ai.generateText({
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools,
        ...additionalOptions,
      })

      const toolCallId = result.steps[0].toolCalls[0].toolCallId

      const { apmSpans, llmobsSpans } = await getEvents(4)

      const expectedWorkflowMetadata = {}
      if (semifies(realVersion, '>=5.0.0')) {
        expectedWorkflowMetadata.maxRetries = MOCK_NUMBER
      } else {
        expectedWorkflowMetadata.maxSteps = MOCK_NUMBER
      }

      assertLlmObsSpanEvent(llmobsSpans[0], {
        span: apmSpans[0],
        name: 'generateText',
        spanKind: 'workflow',
        inputValue: 'What is the weather in Tokyo?',
        outputValue: MOCK_STRING,
        metadata: expectedWorkflowMetadata,
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'doGenerate',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is the weather in Tokyo?', role: 'user' },
        ],
        outputMessages: [{
          role: 'assistant',
          tool_calls: [{
            tool_id: toolCallId,
            name: 'weather',
            arguments: {
              location: 'Tokyo',
            },
            type: 'function',
          }],
        }],
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[2], {
        span: apmSpans[2],
        parentId: llmobsSpans[0].span_id,
        name: 'weather',
        spanKind: 'tool',
        inputValue: '{"location":"Tokyo"}',
        outputValue: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[3], {
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
              tool_id: toolCallId,
              name: 'weather',
              arguments: {
                location: 'Tokyo',
              },
              type: 'function',
            }],
          },
          {
            content: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
            role: 'tool',
            tool_id: toolCallId,
          },
        ],
        outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it('created a span for a tool call from a stream', async () => {
      let tools
      let additionalOptions
      const toolSchema = ai.jsonSchema({
        type: 'object',
        properties: {
          location: { type: 'string', description: 'The location to get the weather for' },
        },
        required: ['location'],
      })

      if (semifies(realVersion, '>=5.0.0')) {
        tools = {
          weather: ai.tool({
            description: 'Get the weather in a given location',
            inputSchema: toolSchema,
            execute: async ({ location }) => ({
              location,
              temperature: 72,
            }),
          }),
        }

        additionalOptions = { stopWhen: ai.stepCountIs(5) }
      } else {
        tools = [ai.tool({
          id: 'weather',
          description: 'Get the weather in a given location',
          parameters: toolSchema,
          execute: async ({ location }) => ({
            location,
            temperature: 72,
          }),
        })]

        additionalOptions = { maxSteps: 5 }
      }

      if (semifies(openaiVersion, '>=2.0.50')) {
        additionalOptions.providerOptions = {
          openai: {
            store: false,
          },
        }
      }

      const result = await ai.streamText({
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools,
        ...additionalOptions,
      })

      const textStream = result.textStream

      for await (const part of textStream) {} // eslint-disable-line

      const stepsPromise = result._steps ?? result.stepsPromise
      const steps = stepsPromise.status.value
      const toolCallId = steps[0].toolCalls[0].toolCallId

      const { apmSpans, llmobsSpans } = await getEvents(4)

      const expectedWorkflowMetadata = {}
      if (semifies(realVersion, '>=5.0.0')) {
        expectedWorkflowMetadata.maxRetries = MOCK_NUMBER
      } else {
        expectedWorkflowMetadata.maxSteps = MOCK_NUMBER
      }

      assertLlmObsSpanEvent(llmobsSpans[0], {
        span: apmSpans[0],
        name: 'streamText',
        spanKind: 'workflow',
        inputValue: 'What is the weather in Tokyo?',
        outputValue: MOCK_STRING,
        metadata: expectedWorkflowMetadata,
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'doStream',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is the weather in Tokyo?', role: 'user' },
        ],
        outputMessages: [{
          content: MOCK_STRING,
          role: 'assistant',
          tool_calls: [{
            tool_id: toolCallId,
            name: 'weather',
            arguments: {
              location: 'Tokyo',
            },
            type: 'function',
          }],
        }],
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[2], {
        span: apmSpans[2],
        parentId: llmobsSpans[0].span_id,
        /**
         * Before ai@4.0.2, the stream implementation did not finish the initial llm spans
         * first to associate the tool call id with the tool itself (by matching descriptions).
         *
         * Usually, this would mean the tool call name is 'toolCall'. This is a limitation with the older library
         * versions. In v5+, this is resolved as the tool name is not its index in the tools array, but its actual name.
         */
        name: semifies(realVersion, NODE_MAJOR < 22 ? '<=4.0.2' : '<4.0.2') ? 'toolCall' : 'weather',
        spanKind: 'tool',
        inputValue: JSON.stringify({ location: 'Tokyo' }),
        outputValue: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[3], {
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
              tool_id: toolCallId,
              name: 'weather',
              arguments: {
                location: 'Tokyo',
              },
              type: 'function',
            }],
          },
          {
            content: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
            role: 'tool',
            tool_id: toolCallId,
          },
        ],
        outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it('creates a span that respects the functionId', async () => {
      const options = {
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        temperature: 0.5,
        experimental_telemetry: {
          functionId: 'test',
        },
      }

      if (semifies(realVersion, '>=5.0.0')) {
        options.maxOutputTokens = 100
      } else {
        options.maxTokens = 100
      }

      await ai.generateText(options)

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedWorkflowMetadata = {}
      if (semifies(realVersion, '>=5.0.0')) {
        expectedWorkflowMetadata.maxRetries = MOCK_NUMBER
        expectedWorkflowMetadata.maxOutputTokens = 100
      } else {
        expectedWorkflowMetadata.maxSteps = MOCK_NUMBER
      }

      assertLlmObsSpanEvent(llmobsSpans[0], {
        span: apmSpans[0],
        name: 'test.generateText',
        spanKind: 'workflow',
        inputValue: 'Hello, OpenAI!',
        outputValue: MOCK_STRING,
        metadata: expectedWorkflowMetadata,
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'test.doGenerate',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'Hello, OpenAI!', role: 'user' },
        ],
        outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
        metadata: {
          max_tokens: 100,
          temperature: 0.5,
        },
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    describe('ToolLoopAgent', function () {
      beforeEach(function () {
        if (semifies(realVersion, '<6.0.0')) {
          this.skip()
        }
      })

      it('creates a text generation root span for ToolLoopAgent.generate', async () => {
        const agent = new ai.ToolLoopAgent({
          model: openai('gpt-4o-mini'),
          instructions: 'You are a helpful assistant',
          providerOptions: {
            openai: {
              store: false,
            },
          },
          tools: {
            weather: ai.tool({
              description: 'Get the weather in a given location',
              inputSchema: ai.jsonSchema({
                type: 'object',
                properties: {
                  location: { type: 'string', description: 'The location to get the weather for' },
                },
              }),
              execute: async ({ location }) => ({
                location,
                temperature: 72,
              }),
            }),
          },
        })

        const result = await agent.generate({
          prompt: 'What is the weather in Tokyo?',
        })

        const toolCallId = result.steps[0].toolCalls[0].toolCallId

        const { apmSpans, llmobsSpans } = await getEvents(4)

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          name: 'generateText',
          spanKind: 'workflow',
          inputValue: 'What is the weather in Tokyo?',
          outputValue: MOCK_STRING,
          metadata: {
            maxRetries: MOCK_NUMBER,
          },
          tags: { ml_app: 'test', integration: 'ai' },
        })

        assertLlmObsSpanEvent(llmobsSpans[1], {
          span: apmSpans[1],
          parentId: llmobsSpans[0].span_id,
          spanKind: 'llm',
          modelName: 'gpt-4o-mini',
          modelProvider: 'openai',
          name: 'doGenerate',
          inputMessages: [
            { content: 'You are a helpful assistant', role: 'system' },
            { content: 'What is the weather in Tokyo?', role: 'user' },
          ],
          outputMessages: [{
            role: 'assistant',
            tool_calls: [{
              tool_id: toolCallId,
              name: 'weather',
              arguments: {
                location: 'Tokyo',
              },
              type: 'function',
            }],
          }],
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
          tags: { ml_app: 'test', integration: 'ai' },
        })

        assertLlmObsSpanEvent(llmobsSpans[2], {
          span: apmSpans[2],
          parentId: llmobsSpans[0].span_id,
          name: 'weather',
          spanKind: 'tool',
          inputValue: JSON.stringify({ location: 'Tokyo' }),
          outputValue: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
          tags: { ml_app: 'test', integration: 'ai' },
        })

        assertLlmObsSpanEvent(llmobsSpans[3], {
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
                tool_id: toolCallId,
                name: 'weather',
                arguments: {
                  location: 'Tokyo',
                },
                type: 'function',
              }],
            },
            {
              content: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
              role: 'tool',
              tool_id: toolCallId,
            },
          ],
          outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
          tags: { ml_app: 'test', integration: 'ai' },
        })
      })

      it('creates a text generation root span for ToolLoopAgent.stream', async () => {
        const agent = new ai.ToolLoopAgent({
          model: openai('gpt-4o-mini'),
          instructions: 'You are a helpful assistant',
          providerOptions: {
            openai: {
              store: false,
            },
          },
          tools: {
            weather: ai.tool({
              description: 'Get the weather in a given location',
              inputSchema: ai.jsonSchema({
                type: 'object',
                properties: {
                  location: { type: 'string', description: 'The location to get the weather for' },
                },
              }),
              execute: async ({ location }) => ({
                location,
                temperature: 72,
              }),
            }),
          },
        })

        const result = await agent.stream({
          prompt: 'What is the weather in Tokyo?',
        })

        const textStream = result.textStream

        for await (const part of textStream) {} // eslint-disable-line

        const stepsPromise = result._steps ?? result.stepsPromise
        const steps = stepsPromise.status.value
        const toolCallId = steps[0].toolCalls[0].toolCallId

        const { apmSpans, llmobsSpans } = await getEvents(4)

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          name: 'streamText',
          spanKind: 'workflow',
          inputValue: 'What is the weather in Tokyo?',
          outputValue: MOCK_STRING,
          metadata: {
            maxRetries: MOCK_NUMBER,
          },
          tags: { ml_app: 'test', integration: 'ai' },
        })

        assertLlmObsSpanEvent(llmobsSpans[1], {
          span: apmSpans[1],
          parentId: llmobsSpans[0].span_id,
          spanKind: 'llm',
          modelName: 'gpt-4o-mini',
          modelProvider: 'openai',
          name: 'doStream',
          inputMessages: [
            { content: 'You are a helpful assistant', role: 'system' },
            { content: 'What is the weather in Tokyo?', role: 'user' },
          ],
          outputMessages: [{
            role: 'assistant',
            content: MOCK_STRING,
            tool_calls: [{
              tool_id: toolCallId,
              name: 'weather',
              arguments: {
                location: 'Tokyo',
              },
              type: 'function',
            }],
          }],
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
          tags: { ml_app: 'test', integration: 'ai' },
        })

        assertLlmObsSpanEvent(llmobsSpans[2], {
          span: apmSpans[2],
          parentId: llmobsSpans[0].span_id,
          name: 'weather',
          spanKind: 'tool',
          inputValue: JSON.stringify({ location: 'Tokyo' }),
          outputValue: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
          tags: { ml_app: 'test', integration: 'ai' },
        })

        assertLlmObsSpanEvent(llmobsSpans[3], {
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
                tool_id: toolCallId,
                name: 'weather',
                arguments: {
                  location: 'Tokyo',
                },
                type: 'function',
              }],
            },
            {
              content: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
              role: 'tool',
              tool_id: toolCallId,
            },
          ],
          outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
          tags: { ml_app: 'test', integration: 'ai' },
        })
      })
    })
  })

  describe('prompt cache token capture', () => {
    // Both @ai-sdk/amazon-bedrock and @ai-sdk/anthropic use globalThis.fetch
    // (not node:http), so nock cannot intercept them. Each provider's
    // create*() factory accepts an options.fetch parameter, so we pass a mock
    // fetch directly rather than patching globalThis.fetch — this avoids both
    // the nock limitation and timing issues around when globalThis.fetch is
    // captured.
    function makeMockFetch (scenario) {
      const fixture = require(`../../../../../datadog-plugin-ai/test/resources/${scenario}.json`)
      return () => new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // @ai-sdk/amazon-bedrock signs requests with aws4fetch, which calls
    // globalThis.crypto for SHA256/HMAC. Node 19+ exposes crypto as a global;
    // on Node 18 (still supported and used in CI) we polyfill it from
    // node:crypto.webcrypto. (Anthropic doesn't need this — simple API key auth.)
    before(() => {
      if (typeof globalThis.crypto === 'undefined') {
        globalThis.crypto = require('node:crypto').webcrypto
      }
    })

    // Default expectations matching the "SDK-normalized" pattern used by Bedrock
    // and Anthropic: input_tokens is the raw fresh count on v5-paired packages
    // and the sum on v6-paired packages.
    function defaultExpectedMetrics ({ scenario, isV6, cacheReadOnDoGenerate }) {
      if (scenario === 'cache-read') {
        return {
          input_tokens: isV6 ? 4448 : 23,
          cache_read_input_tokens: cacheReadOnDoGenerate ? 4425 : undefined,
          cache_write_input_tokens: undefined,
        }
      }
      if (scenario === 'cache-write') {
        return {
          input_tokens: isV6 ? 4448 : 23,
          cache_write_input_tokens: 4425,
          cache_read_input_tokens: undefined,
        }
      }
      throw new Error(`Unknown scenario: ${scenario}`)
    }

    /**
     * Generic helper that runs prompt-cache capture tests for a given AI SDK
     * provider. New providers can be added by passing a single config object —
     * no test-orchestration code duplication required.
     *
     * @param {object} config
     * @param {string} config.providerName - Display name (e.g., 'Bedrock', 'Anthropic')
     * @param {(realVersion: string) => string | null} config.getPackage -
     *   Returns the versioned package path for the given ai version, or null
     *   to skip that ai version (no compatible provider package)
     * @param {(PackageModule: object, scenario: string) => object} config.buildModel -
     *   Constructs the provider's language model with mock fetch wired in
     * @param {object} [config.env] - Env vars required during tests (e.g. AWS creds)
     * @param {string[]} [config.scenarios] - Scenarios to test for this provider.
     *   Defaults to both. Providers without cache_write support (e.g. OpenAI)
     *   should pass ['cache-read'] only.
     * @param {(opts: object) => object} [config.getExpectedMetrics] -
     *   Override the default expected-metrics function. Providers whose
     *   input_tokens semantics differ from the SDK-normalized pattern (e.g.
     *   OpenAI's `prompt_tokens` is already the sum at the API level) can
     *   provide their own version-aware expectations.
     */
    function describeProviderCacheTests ({
      providerName,
      getPackage,
      buildModel,
      env,
      scenarios = ['cache-read', 'cache-write'],
      getExpectedMetrics = defaultExpectedMetrics,
    }) {
      describe(`${providerName}`, () => {
        if (env) useEnv(env)

        withVersions('ai', 'ai', '>=5.0.0', (version, _, realVersion) => {
          const pkg = getPackage(realVersion)
          if (!pkg) return

          let ai
          let PackageModule

          beforeEach(() => {
            ai = require(`../../../../../../versions/ai@${version}`).get()
            PackageModule = require(`../../../../../../versions/${pkg}`)
          })

          // AI SDK v6+ aggregates inputTokens + cacheReadInputTokens + cacheWriteInputTokens
          // into `ai.usage.inputTokens` (the total processed). v5 passes the raw fresh
          // count through unchanged. Fixtures use the raw provider shape (inputTokens = fresh only).
          const isV6 = semifies(realVersion, '>=6.0.0')

          // `ai.usage.cachedInputTokens` is only set on the `doGenerate` span starting
          // in ai@6.0.184 (older v6 and all v5 versions set it on the parent span only).
          // For those older versions our fix correctly no-ops at the doGenerate scope
          // because the SDK never exposes the attribute there.
          const cacheReadOnDoGenerate = semifies(realVersion, '>=6.0.184')

          if (scenarios.includes('cache-read')) {
            it(`surfaces cache_read_input_tokens when ${providerName} returns cache read tokens`, async () => {
              const model = buildModel(PackageModule, 'cache-read')
              await ai.generateText({ model, prompt: 'What does Datadog LLM Observability do?' })

              const { llmobsSpans } = await getEvents()
              const doGenerateSpan = llmobsSpans.find(s => s.name === 'doGenerate')

              const expected = getExpectedMetrics({ scenario: 'cache-read', isV6, cacheReadOnDoGenerate })
              assert.equal(doGenerateSpan.metrics.input_tokens, expected.input_tokens)
              assert.equal(doGenerateSpan.metrics.cache_read_input_tokens, expected.cache_read_input_tokens)
              assert.equal(doGenerateSpan.metrics.cache_write_input_tokens, expected.cache_write_input_tokens)
            })
          }

          if (scenarios.includes('cache-write')) {
            it(`surfaces cache_write_input_tokens when ${providerName} returns cache write tokens`, async () => {
              const model = buildModel(PackageModule, 'cache-write')
              await ai.generateText({ model, prompt: 'What does Datadog LLM Observability do?' })

              const { llmobsSpans } = await getEvents()
              const doGenerateSpan = llmobsSpans.find(s => s.name === 'doGenerate')

              const expected = getExpectedMetrics({ scenario: 'cache-write', isV6, cacheReadOnDoGenerate })
              assert.equal(doGenerateSpan.metrics.input_tokens, expected.input_tokens)
              assert.equal(doGenerateSpan.metrics.cache_write_input_tokens, expected.cache_write_input_tokens)
              assert.equal(doGenerateSpan.metrics.cache_read_input_tokens, expected.cache_read_input_tokens)
            })
          }
        })
      })
    }

    describeProviderCacheTests({
      providerName: 'Bedrock',
      getPackage: getAiSdkBedrockPackage,
      buildModel: (BedrockModule, scenario) => {
        const { createAmazonBedrock } = BedrockModule.get()
        return createAmazonBedrock({
          region: 'us-east-1',
          fetch: makeMockFetch(`bedrock-${scenario}`),
        })('anthropic.claude-3-haiku-20240307-v1:0')
      },
      env: {
        AWS_ACCESS_KEY_ID: 'test-access-key',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
        AWS_REGION: 'us-east-1',
      },
    })

    describeProviderCacheTests({
      providerName: 'Anthropic',
      getPackage: getAiSdkAnthropicPackage,
      buildModel: (AnthropicModule, scenario) => {
        const { createAnthropic } = AnthropicModule.get()
        return createAnthropic({
          apiKey: 'test-api-key',
          fetch: makeMockFetch(`anthropic-${scenario}`),
        })('claude-3-5-haiku-20241022')
      },
    })

    // OpenAI's caching is implicit / server-side; no per-request cache_write metric.
    // OpenAI's `prompt_tokens` (Chat Completions) / `input_tokens` (Responses) already
    // include cached tokens at the API level, so `ai.usage.inputTokens` is the sum
    // across all ai versions — unlike Bedrock/Anthropic where the v5-paired SDK
    // passes raw fresh through.
    const openaiExpectedMetrics = ({ scenario, cacheReadOnDoGenerate }) => {
      if (scenario === 'cache-read') {
        return {
          input_tokens: 4448,
          cache_read_input_tokens: cacheReadOnDoGenerate ? 4425 : undefined,
          cache_write_input_tokens: undefined,
        }
      }
      throw new Error(`OpenAI does not support scenario: ${scenario}`)
    }

    describeProviderCacheTests({
      providerName: 'OpenAI (Chat Completions)',
      getPackage: getAiSdkOpenAiPackage,
      buildModel: (OpenAiModule, scenario) => {
        const { createOpenAI } = OpenAiModule.get()
        // Use `.chat()` to force the Chat Completions endpoint. Cache field path
        // is `usage.prompt_tokens_details.cached_tokens`.
        return createOpenAI({
          apiKey: 'test-api-key',
          fetch: makeMockFetch(`openai-${scenario}`),
          compatibility: 'strict',
        }).chat('gpt-4o-mini')
      },
      scenarios: ['cache-read'],
      getExpectedMetrics: openaiExpectedMetrics,
    })

    describeProviderCacheTests({
      providerName: 'OpenAI (Responses API)',
      getPackage: getAiSdkOpenAiPackage,
      buildModel: (OpenAiModule, scenario) => {
        const { createOpenAI } = OpenAiModule.get()
        // Default `openai(modelId)` routes to the Responses API on
        // @ai-sdk/openai v1/v2/v3. Cache field path is
        // `usage.input_tokens_details.cached_tokens`. As OpenAI migrates
        // customers from Chat Completions to Responses, this path should
        // become the more common one.
        return createOpenAI({
          apiKey: 'test-api-key',
          fetch: makeMockFetch(`openai-responses-${scenario}`),
        })('gpt-4o-mini')
      },
      scenarios: ['cache-read'],
      getExpectedMetrics: openaiExpectedMetrics,
    })

    describeProviderCacheTests({
      providerName: 'Google Gemini',
      getPackage: getAiSdkGooglePackage,
      buildModel: (GoogleModule, scenario) => {
        const { createGoogleGenerativeAI } = GoogleModule.get()
        // Google's response has a genuinely different shape from OpenAI:
        // `usageMetadata.cachedContentTokenCount`. By covering Google we
        // prove that the `ai.usage.cachedInputTokens` standardized-attribute
        // path works against a third upstream API shape distinct from the
        // OpenAI-compatible family (which xAI, Mistral OpenAI-mode, etc. share).
        return createGoogleGenerativeAI({
          apiKey: 'test-api-key',
          fetch: makeMockFetch(`google-${scenario}`),
        })('gemini-2.5-flash')
      },
      // Google's context caching is a separate API call to create the cache;
      // per-request responses only report cache reads.
      scenarios: ['cache-read'],
      // Google's `promptTokenCount` already includes cached tokens at the API
      // level (same convention as OpenAI), so `ai.usage.inputTokens` is the
      // sum across all ai versions.
      getExpectedMetrics: ({ scenario, cacheReadOnDoGenerate }) => {
        if (scenario === 'cache-read') {
          return {
            input_tokens: 4448,
            cache_read_input_tokens: cacheReadOnDoGenerate ? 4425 : undefined,
            cache_write_input_tokens: undefined,
          }
        }
        throw new Error(`Google does not support scenario: ${scenario}`)
      },
    })
  })
})
