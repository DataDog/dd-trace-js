'use strict'

const { useEnv } = require('../../../../../../integration-tests/helpers')
const semifies = require('semifies')
const { withVersions } = require('../../../setup/mocha')

const { NODE_MAJOR } = require('../../../../../../version')

const {
  assertLlmObsSpanEvent,
  MOCK_STRING,
  useLlmObs,
  MOCK_NUMBER,
  MOCK_OBJECT
} = require('../../util')

// ai<4.0.2 is not supported in CommonJS with Node.js < 22
const range = NODE_MAJOR < 22 ? '>=4.0.2' : '>=4.0.0'

function getAiSdkOpenAiPackage (vercelAiVersion) {
  return semifies(vercelAiVersion, '>=5.0.0') ? '@ai-sdk/openai' : '@ai-sdk/openai@1.3.23'
}

describe('Plugin', () => {
  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>'
  })

  const getEvents = useLlmObs({ plugin: 'ai' })

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
        compatibility: 'strict'
      })
    })

    it('creates a span for generateText', async () => {
      const options = {
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        temperature: 0.5
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
        name: 'generateText',
        spanKind: 'workflow',
        inputData: 'Hello, OpenAI!',
        outputData: MOCK_STRING,
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
        inputData: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'Hello, OpenAI!', role: 'user' }
        ],
        outputData: [{ content: MOCK_STRING, role: 'assistant' }],
        metadata: {
          max_tokens: 100,
          temperature: 0.5,
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

      const expectedWorkflowMetadata = {
        schema: MOCK_OBJECT,
        output: 'object',
      }
      if (semifies(realVersion, '>=5.0.0')) {
        expectedWorkflowMetadata.maxRetries = MOCK_NUMBER
      }

      assertLlmObsSpanEvent(llmobsSpans[0], {
        span: apmSpans[0],
        name: 'generateObject',
        spanKind: 'workflow',
        inputData: 'Invent a character for a video game',
        outputData: MOCK_STRING,
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
        inputData: [{ content: 'Invent a character for a video game', role: 'user' }],
        outputData: [{ content: MOCK_STRING, role: 'assistant' }],
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' }
      })
    })

    it('creates a span for embed', async () => {
      await ai.embed({
        model: openai.embedding('text-embedding-ada-002'),
        value: 'hello world'
      })

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpanEvent = {
        span: apmSpans[0],
        name: 'embed',
        spanKind: 'workflow',
        inputData: 'hello world',
        outputData: '[1 embedding(s) returned with size 1536]',
        tags: { ml_app: 'test', integration: 'ai' }
      }

      if (semifies(realVersion, '>=5.0.0')) {
        expectedWorkflowSpanEvent.metadata = {
          maxRetries: MOCK_NUMBER
        }
      }

      assertLlmObsSpanEvent(llmobsSpans[0], expectedWorkflowSpanEvent)

      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'embedding',
        modelName: 'text-embedding-ada-002',
        modelProvider: 'openai',
        name: 'doEmbed',
        inputData: [{ text: 'hello world' }],
        outputData: '[1 embedding(s) returned with size 1536]',
        metrics: { input_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' }
      })
    })

    it('creates a span for embedMany', async () => {
      await ai.embedMany({
        model: openai.embedding('text-embedding-ada-002'),
        values: ['hello world', 'goodbye world']
      })

      const { apmSpans, llmobsSpans } = await getEvents()

      const expectedWorkflowSpanEvent = {
        span: apmSpans[0],
        name: 'embedMany',
        spanKind: 'workflow',
        inputData: JSON.stringify(['hello world', 'goodbye world']),
        outputData: '[2 embedding(s) returned with size 1536]',
        tags: { ml_app: 'test', integration: 'ai' }
      }
      if (semifies(realVersion, '>=5.0.0')) {
        expectedWorkflowSpanEvent.metadata = {
          maxRetries: MOCK_NUMBER
        }
      }

      assertLlmObsSpanEvent(llmobsSpans[0], expectedWorkflowSpanEvent)

      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'embedding',
        modelName: 'text-embedding-ada-002',
        modelProvider: 'openai',
        name: 'doEmbed',
        inputData: [{ text: 'hello world' }, { text: 'goodbye world' }],
        outputData: '[2 embedding(s) returned with size 1536]',
        metrics: { input_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' }
      })
    })

    // TODO(sabrenner): re-enable this test once #6707 lands
    it.skip('creates a span for streamText', async () => {
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

      const expectedMetadata =
        semifies(realVersion, '>=5.0.0')
          ? { maxRetries: MOCK_NUMBER }
          : { maxSteps: MOCK_NUMBER }

      assertLlmObsSpanEvent(llmobsSpans[0], {
        span: apmSpans[0],
        name: 'streamText',
        spanKind: 'workflow',
        inputData: 'Hello, OpenAI!',
        outputData: 'Hello! How can I assist you today?', // assert text from stream is fully captured
        metadata: expectedMetadata,
        tags: { ml_app: 'test', integration: 'ai' }
      })

      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'doStream',
        inputData: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'Hello, OpenAI!', role: 'user' }
        ],
        outputData: [{ content: 'Hello! How can I assist you today?', role: 'assistant' }],
        metadata: {
          max_tokens: 100,
          temperature: 0.5,
        },
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' }
      })
    })

    // TODO(sabrenner): re-enable this test once #6707 lands
    it.skip('creates a span for streamObject', async () => {
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

      const expectedWorkflowMetadata = {
        schema: MOCK_OBJECT,
        output: 'object',
      }
      if (semifies(realVersion, '>=5.0.0')) {
        expectedWorkflowMetadata.maxRetries = MOCK_NUMBER
      }

      assertLlmObsSpanEvent(llmobsSpans[0], {
        span: apmSpans[0],
        name: 'streamObject',
        spanKind: 'workflow',
        inputData: 'Invent a character for a video game',
        outputData: JSON.stringify(expectedCharacter),
        metadata: expectedWorkflowMetadata,
        tags: { ml_app: 'test', integration: 'ai' }
      })

      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'doStream',
        inputData: [{ content: 'Invent a character for a video game', role: 'user' }],
        outputData: [{
          content: JSON.stringify(expectedCharacter),
          role: 'assistant'
        }],
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' }
      })
    })

    // TODO(sabrenner): Fix this test for v5.0.0 - tool "input" instead of "arguments"
    it.skip('creates a span for a tool call', async () => {
      let tools
      let additionalOptions = {}
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

        additionalOptions = { stopWhen: ai.stepCountIs(5) }
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

        additionalOptions = { maxSteps: 5 }
      }

      if (semifies(openaiVersion, '>=2.0.50')) {
        additionalOptions.providerOptions = {
          openai: {
            store: false
          }
        }
      }

      await ai.generateText({
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools,
        ...additionalOptions
      })

      const { apmSpans, llmobsSpans } = await getEvents()

      let expectedFinalOutput

      if (semifies(openaiVersion, '>=2.0.50')) {
        expectedFinalOutput = 'The current temperature in Tokyo is 72°F.'
      } else if (semifies(realVersion, '>=5.0.0')) {
        expectedFinalOutput =
          'The current temperature in Tokyo is 72°F. If you need more details about the weather, just let me know!'
      } else {
        expectedFinalOutput = 'The current weather in Tokyo is 72°F.'
      }

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
        inputData: 'What is the weather in Tokyo?',
        outputData: expectedFinalOutput,
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
        inputData: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is the weather in Tokyo?', role: 'user' }
        ],
        outputData: [{
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
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[2], {
        span: apmSpans[2],
        parentId: llmobsSpans[0].span_id,
        name: 'weather',
        spanKind: 'tool',
        inputData: '{"location":"Tokyo"}',
        outputData: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[3], {
        span: apmSpans[3],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'doGenerate',
        inputData: [
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
        outputData: [{ content: expectedFinalOutput, role: 'assistant' }],
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it.skip('created a span for a tool call from a stream', async () => {
      // TODO(sabrenner): Fix this test for v5.0.0 - tool "input" instead of "arguments" & parsing, streaming
      let tools
      let additionalOptions = {}
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

        additionalOptions = { stopWhen: ai.stepCountIs(5) }
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

        additionalOptions = { maxSteps: 5 }
      }

      if (semifies(openaiVersion, '>=2.0.50')) {
        additionalOptions.providerOptions = {
          openai: {
            store: false
          }
        }
      }

      const result = await ai.streamText({
        model: openai('gpt-4o-mini'),
        system: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools,
        ...additionalOptions
      })

      const textStream = result.textStream

      for await (const part of textStream) {} // eslint-disable-line

      const { apmSpans, llmobsSpans } = await getEvents()

      let expectedFinalOutput

      if (semifies(openaiVersion, '>=2.0.50')) {
        expectedFinalOutput =
        'The current temperature in Tokyo is 72°F. If you need more detailed weather information, feel free to ask!'
      } else if (semifies(realVersion, '>=5.0.0')) {
        expectedFinalOutput =
          'The current temperature in Tokyo is 72°F. If you need more details or specific forecasts, feel free to ask!'
      } else {
        expectedFinalOutput = 'The current weather in Tokyo is 72°F.'
      }

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
        inputData: 'What is the weather in Tokyo?',
        outputData: expectedFinalOutput,
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
        inputData: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is the weather in Tokyo?', role: 'user' }
        ],
        outputData: [{
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
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[2], {
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
        inputData: JSON.stringify({ location: 'Tokyo' }),
        outputData: JSON.stringify({ location: 'Tokyo', temperature: 72 }),
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(llmobsSpans[3], {
        span: apmSpans[3],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'doStream',
        inputData: [
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
        outputData: [{ content: expectedFinalOutput, role: 'assistant' }],
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
          functionId: 'test'
        }
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
        inputData: 'Hello, OpenAI!',
        outputData: MOCK_STRING,
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
        inputData: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'Hello, OpenAI!', role: 'user' }
        ],
        outputData: [{ content: MOCK_STRING, role: 'assistant' }],
        metadata: {
          max_tokens: 100,
          temperature: 0.5,
        },
        metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })
  })
})
