'use strict'

const assert = require('node:assert/strict')

const { useEnv } = require('../../../../../../integration-tests/helpers')
const { withVersions } = require('../../../setup/mocha')

const {
  assertLlmObsSpanEvent,
  MOCK_STRING,
  useLlmObs,
  MOCK_NUMBER,
} = require('../../util')

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

  withVersions('ai', 'ai', '>=7.0.0', (version) => {
    let ai
    let openai

    beforeEach(function () {
      ai = require(`../../../../../../versions/ai@${version}`).get()

      const OpenAI = require('../../../../../../versions/@ai-sdk/openai').get()
      openai = OpenAI.createOpenAI({
        baseURL: 'http://127.0.0.1:9126/vcr/openai',
        compatibility: 'strict',
      })
    })

    it('creates spans for generateText', async () => {
      await ai.generateText({
        model: openai('gpt-4o-mini'),
        instructions: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxOutputTokens: 100,
        temperature: 0.5,
        runtimeContext: MOCK_TELEMETRY_METADATA,
      })

      // generateText (workflow) + step (step) + languageModelCall (llm)
      const { apmSpans, llmobsSpans } = await getEvents(3)

      const generateTextSpan = llmobsSpans.find(s => s.name === 'generateText')
      const stepSpan = llmobsSpans.find(s => s.name === 'step')
      const languageModelCallSpan = llmobsSpans.find(s => s.name === 'languageModelCall')

      const generateTextApmSpan = apmSpans.find(s => s.name === 'generateText')
      const stepApmSpan = apmSpans.find(s => s.name === 'step')
      const languageModelCallApmSpan = apmSpans.find(s => s.name === 'languageModelCall')

      assertLlmObsSpanEvent(generateTextSpan, {
        span: generateTextApmSpan,
        name: 'generateText',
        spanKind: 'workflow',
        inputValue: 'Hello, OpenAI!',
        outputValue: MOCK_STRING,
        // getGenerationMetadataFromEvent: captures MODEL_METADATA_KEYS + runtimeContext only
        // temperature (in MODEL_METADATA_KEYS) + custom metadata from runtimeContext
        metadata: {
          temperature: 0.5,
          ...MOCK_TELEMETRY_METADATA,
        },
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(stepSpan, {
        span: stepApmSpan,
        parentId: generateTextSpan.span_id,
        name: 'step',
        spanKind: 'step',
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(languageModelCallSpan, {
        span: languageModelCallApmSpan,
        parentId: stepSpan.span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'languageModelCall',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'Hello, OpenAI!', role: 'user' },
        ],
        outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
        // languageModelCall event does not include runtimeContext, only MODEL_METADATA_KEYS
        metadata: {
          temperature: 0.5,
        },
        // v7 usage: nested inputTokens/outputTokens, no total_tokens; cache/reasoning default to 0
        metrics: {
          input_tokens: MOCK_NUMBER,
          cache_write_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: MOCK_NUMBER,
          reasoning_output_tokens: 0,
        },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it('creates a span for embed', async () => {
      await ai.embed({
        model: openai.embedding('text-embedding-ada-002'),
        value: 'hello world',
        runtimeContext: MOCK_TELEMETRY_METADATA,
      })

      // embed maps to 'embedding' kind in v7 (single span, no outer workflow)
      const { apmSpans, llmobsSpans } = await getEvents(1)

      const embedSpan = llmobsSpans.find(s => s.name === 'embed')
      const embedApmSpan = apmSpans.find(s => s.name === 'embed')

      assertLlmObsSpanEvent(embedSpan, {
        span: embedApmSpan,
        name: 'embed',
        spanKind: 'embedding',
        modelName: 'text-embedding-ada-002',
        modelProvider: 'openai',
        inputDocuments: [{ text: 'hello world' }],
        outputValue: '[1 embedding(s) returned with size 1536]',
        metrics: { input_tokens: MOCK_NUMBER },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    // eslint-disable-next-line mocha/no-pending-tests
    it.skip('creates a span for embedMany', async () => {
      await ai.embedMany({
        model: openai.embedding('text-embedding-ada-002'),
        values: ['hello world', 'goodbye world'],
        runtimeContext: MOCK_TELEMETRY_METADATA,
      })

      // embedMany maps to 'workflow' kind but setLLMObsTags has no embedMany case → no IO tags
      const { apmSpans, llmobsSpans } = await getEvents(1)

      const embedManySpan = llmobsSpans.find(s => s.name === 'embedMany')
      const embedManyApmSpan = apmSpans.find(s => s.name === 'embedMany')

      assertLlmObsSpanEvent(embedManySpan, {
        span: embedManyApmSpan,
        name: 'embedMany',
        spanKind: 'workflow',
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it('creates spans for streamText', async () => {
      const result = await ai.streamText({
        model: openai('gpt-4o-mini'),
        instructions: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxOutputTokens: 100,
        temperature: 0.5,
        runtimeContext: MOCK_TELEMETRY_METADATA,
      })

      for await (const part of result.textStream) {} // eslint-disable-line

      // streamText (workflow) + step (step) + languageModelCall (llm)
      // streamText also calls setTextGenerationTags — output assembled from chunks
      const { apmSpans, llmobsSpans } = await getEvents(3)

      const streamTextSpan = llmobsSpans.find(s => s.name === 'streamText')
      const stepSpan = llmobsSpans.find(s => s.name === 'step')
      const languageModelCallSpan = llmobsSpans.find(s => s.name === 'languageModelCall')

      const streamTextApmSpan = apmSpans.find(s => s.name === 'streamText')
      const stepApmSpan = apmSpans.find(s => s.name === 'step')
      const languageModelCallApmSpan = apmSpans.find(s => s.name === 'languageModelCall')

      assertLlmObsSpanEvent(streamTextSpan, {
        span: streamTextApmSpan,
        name: 'streamText',
        spanKind: 'workflow',
        inputValue: 'Hello, OpenAI!',
        outputValue: 'Hello! How can I assist you today?',
        metadata: {
          temperature: 0.5,
          ...MOCK_TELEMETRY_METADATA,
        },
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(stepSpan, {
        span: stepApmSpan,
        parentId: streamTextSpan.span_id,
        name: 'step',
        spanKind: 'step',
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(languageModelCallSpan, {
        span: languageModelCallApmSpan,
        parentId: stepSpan.span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'languageModelCall',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'Hello, OpenAI!', role: 'user' },
        ],
        outputMessages: [{ content: 'Hello! How can I assist you today?', role: 'assistant' }],
        // languageModelCall event does not include runtimeContext, only MODEL_METADATA_KEYS
        metadata: {
          temperature: 0.5,
        },
        metrics: {
          input_tokens: MOCK_NUMBER,
          cache_write_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: MOCK_NUMBER,
          reasoning_output_tokens: 0,
        },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it('creates spans for a tool call', async () => {
      const result = await ai.generateText({
        model: openai('gpt-4o-mini'),
        instructions: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools: {
          weather: ai.tool({
            description: 'Get the weather in a given location',
            inputSchema: ai.jsonSchema({
              type: 'object',
              properties: {
                location: { type: 'string', description: 'The location to get the weather for' },
              },
              required: ['location'],
            }),
            execute: async ({ location }) => ({
              location,
              temperature: 72,
            }),
          }),
        },
        stopWhen: ai.stepCountIs(5),
        providerOptions: {
          openai: {
            store: false,
          },
        },
      })

      const toolCallId = result.steps[0].toolCalls[0].toolCallId

      // generateText + step + languageModelCall + executeTool + step + languageModelCall
      const { apmSpans, llmobsSpans } = await getEvents(6)

      const generateTextSpan = llmobsSpans.find(s => s.name === 'generateText')
      const stepSpans = llmobsSpans.filter(s => s.name === 'step')
      const languageModelCallSpans = llmobsSpans.filter(s => s.name === 'languageModelCall')
      const executeToolSpan = llmobsSpans.find(s => s.name === 'weather')

      const generateTextApmSpan = apmSpans.find(s => s.name === 'generateText')
      const stepApmSpans = apmSpans.filter(s => s.name === 'step')
      const languageModelCallApmSpans = apmSpans.filter(s => s.name === 'languageModelCall')
      const executeToolApmSpan = apmSpans.find(s => s.name === 'executeTool')

      assertLlmObsSpanEvent(generateTextSpan, {
        span: generateTextApmSpan,
        name: 'generateText',
        spanKind: 'workflow',
        inputValue: 'What is the weather in Tokyo?',
        outputValue: MOCK_STRING,
        // temperature undefined → { temperature: undefined } → JSON → {}
        metadata: {},
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(stepSpans[0], {
        span: stepApmSpans[0],
        parentId: generateTextSpan.span_id,
        name: 'step',
        spanKind: 'step',
        tags: { ml_app: 'test', integration: 'ai' },
      })

      const weatherToolDefinitions = [{
        name: 'weather',
        description: 'Get the weather in a given location',
        schema: {
          type: 'object',
          properties: { location: { type: 'string', description: 'The location to get the weather for' } },
          required: ['location'],
        },
      }]

      assertLlmObsSpanEvent(languageModelCallSpans[0], {
        span: languageModelCallApmSpans[0],
        parentId: stepSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'languageModelCall',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is the weather in Tokyo?', role: 'user' },
        ],
        outputMessages: [{
          role: 'assistant',
          tool_calls: [{
            tool_id: toolCallId,
            name: 'weather',
            arguments: { location: 'Tokyo' },
            type: 'function',
          }],
        }],
        toolDefinitions: weatherToolDefinitions,
        metadata: {},
        metrics: {
          input_tokens: MOCK_NUMBER,
          cache_write_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: MOCK_NUMBER,
          reasoning_output_tokens: 0,
        },
        tags: { ml_app: 'test', integration: 'ai' },
      })

      // executeTool name comes from event.toolCall.toolName
      assertLlmObsSpanEvent(executeToolSpan, {
        span: executeToolApmSpan,
        parentId: stepSpans[0].span_id,
        name: 'weather',
        spanKind: 'tool',
        inputValue: '{"location":"Tokyo"}',
        outputValue: MOCK_STRING,
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(stepSpans[1], {
        span: stepApmSpans[1],
        parentId: generateTextSpan.span_id,
        name: 'step',
        spanKind: 'step',
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(languageModelCallSpans[1], {
        span: languageModelCallApmSpans[1],
        parentId: stepSpans[1].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'languageModelCall',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is the weather in Tokyo?', role: 'user' },
          {
            role: 'assistant',
            tool_calls: [{
              tool_id: toolCallId,
              name: 'weather',
              arguments: { location: 'Tokyo' },
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
        toolDefinitions: weatherToolDefinitions,
        metadata: {},
        metrics: {
          input_tokens: MOCK_NUMBER,
          cache_write_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: MOCK_NUMBER,
          reasoning_output_tokens: 0,
        },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it('creates spans for a tool call from a stream', async () => {
      const result = await ai.streamText({
        model: openai('gpt-4o-mini'),
        instructions: 'You are a helpful assistant',
        prompt: 'What is the weather in Tokyo?',
        tools: {
          weather: ai.tool({
            description: 'Get the weather in a given location',
            inputSchema: ai.jsonSchema({
              type: 'object',
              properties: {
                location: { type: 'string', description: 'The location to get the weather for' },
              },
              required: ['location'],
            }),
            execute: async ({ location }) => ({
              location,
              temperature: 72,
            }),
          }),
        },
        stopWhen: ai.stepCountIs(5),
        providerOptions: {
          openai: {
            store: false,
          },
        },
      })

      for await (const part of result.textStream) {} // eslint-disable-line

      // v7: result.steps resolves after stream consumption
      const steps = await result.steps
      const toolCallId = steps[0].toolCalls[0].toolCallId

      // streamText + step + languageModelCall + executeTool + step + languageModelCall
      const { apmSpans, llmobsSpans } = await getEvents(6)

      const streamTextSpan = llmobsSpans.find(s => s.name === 'streamText')
      const stepSpans = llmobsSpans.filter(s => s.name === 'step')
      const languageModelCallSpans = llmobsSpans.filter(s => s.name === 'languageModelCall')
      const executeToolSpan = llmobsSpans.find(s => s.name === 'weather')

      const streamTextApmSpan = apmSpans.find(s => s.name === 'streamText')
      const stepApmSpans = apmSpans.filter(s => s.name === 'step')
      const languageModelCallApmSpans = apmSpans.filter(s => s.name === 'languageModelCall')
      const executeToolApmSpan = apmSpans.find(s => s.name === 'executeTool')

      assertLlmObsSpanEvent(streamTextSpan, {
        span: streamTextApmSpan,
        name: 'streamText',
        spanKind: 'workflow',
        inputValue: 'What is the weather in Tokyo?',
        outputValue: MOCK_STRING,
        // temperature undefined → { temperature: undefined } → JSON → {}
        metadata: {},
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(stepSpans[0], {
        span: stepApmSpans[0],
        parentId: streamTextSpan.span_id,
        name: 'step',
        spanKind: 'step',
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(languageModelCallSpans[0], {
        span: languageModelCallApmSpans[0],
        parentId: stepSpans[0].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'languageModelCall',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is the weather in Tokyo?', role: 'user' },
        ],
        outputMessages: [{
          role: 'assistant',
          tool_calls: [{
            tool_id: toolCallId,
            name: 'weather',
            arguments: { location: 'Tokyo' },
            type: 'function',
          }],
        }],
        toolDefinitions: [{
          name: 'weather',
          description: 'Get the weather in a given location',
          schema: {
            type: 'object',
            properties: { location: { type: 'string', description: 'The location to get the weather for' } },
            required: ['location'],
          },
        }],
        metadata: {},
        metrics: {
          input_tokens: MOCK_NUMBER,
          cache_write_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: MOCK_NUMBER,
          reasoning_output_tokens: 0,
        },
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(executeToolSpan, {
        span: executeToolApmSpan,
        parentId: stepSpans[0].span_id,
        name: 'weather',
        spanKind: 'tool',
        inputValue: '{"location":"Tokyo"}',
        outputValue: MOCK_STRING,
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(stepSpans[1], {
        span: stepApmSpans[1],
        parentId: streamTextSpan.span_id,
        name: 'step',
        spanKind: 'step',
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(languageModelCallSpans[1], {
        span: languageModelCallApmSpans[1],
        parentId: stepSpans[1].span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'languageModelCall',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'What is the weather in Tokyo?', role: 'user' },
          {
            role: 'assistant',
            tool_calls: [{
              tool_id: toolCallId,
              name: 'weather',
              arguments: { location: 'Tokyo' },
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
        toolDefinitions: [{
          name: 'weather',
          description: 'Get the weather in a given location',
          schema: {
            type: 'object',
            properties: { location: { type: 'string', description: 'The location to get the weather for' } },
            required: ['location'],
          },
        }],
        metadata: {},
        metrics: {
          input_tokens: MOCK_NUMBER,
          cache_write_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: MOCK_NUMBER,
          reasoning_output_tokens: 0,
        },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })

    it('creates spans for a multi-step workflow', async function () {
      this.timeout(60000)
      const TEMPERATURES = { 'New York, NY': 58, 'Miami, FL': 84, 'Seattle, WA': 52 }

      const getWeather = ai.tool({
        description: 'Get current temperature and sky conditions for a city',
        inputSchema: ai.jsonSchema({
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name, e.g. "Miami, FL"' },
          },
          required: ['city'],
        }),
        execute: async ({ city }) => {
          const tempF = TEMPERATURES[city] ?? 65
          const conditions = tempF > 75 ? 'sunny' : tempF > 60 ? 'partly cloudy' : 'overcast'
          return { city, tempF, conditions }
        },
      })

      const getActivities = ai.tool({
        description: 'Get recommended activities for a city given the current temperature',
        inputSchema: ai.jsonSchema({
          type: 'object',
          properties: {
            city: { type: 'string' },
            tempF: { type: 'number', description: 'Current temperature in Fahrenheit' },
          },
          required: ['city', 'tempF'],
        }),
        execute: async ({ city, tempF }) => {
          const activities = tempF >= 75
            ? ['beach', 'outdoor dining', 'water sports']
            : tempF >= 60
              ? ['city sightseeing', 'cycling', 'outdoor markets']
              : ['museums', 'indoor dining', 'shopping']
          return { city, activities }
        },
      })

      const PROMPT = 'I want to visit New York, Miami, or Seattle this weekend for outdoor activities. ' +
        'Check the weather in all three cities, then get activity recommendations for the best destination.'

      const result = await ai.generateText({
        model: openai('gpt-4o-mini'),
        instructions: 'You are a travel assistant. Check weather for all cities before making a recommendation.',
        prompt: PROMPT,
        tools: { getWeather, getActivities },
        stopWhen: ai.stepCountIs(10),
        temperature: 0,
        providerOptions: {
          openai: { store: false },
        },
      })

      const step1ToolCalls = result.steps[0].toolCalls
      const step2ToolCalls = result.steps[1].toolCalls

      // generateText + 2 steps + 2 languageModelCalls + 3 getWeather + 3 getActivities
      const { apmSpans, llmobsSpans } = await getEvents(11)

      const findApmSpan = llmobsSpan => apmSpans.find(s => s.span_id.toString(10) === llmobsSpan.span_id)

      const generateTextSpan = llmobsSpans.find(s => s.name === 'generateText')
      const stepSpans = llmobsSpans.filter(s => s.name === 'step')
      const languageModelCallSpans = llmobsSpans.filter(s => s.name === 'languageModelCall')
      const getWeatherSpans = llmobsSpans.filter(s => s.name === 'getWeather')
      const getActivitiesSpans = llmobsSpans.filter(s => s.name === 'getActivities')

      // step1 is the parent of getWeather spans; step2 is the parent of getActivities spans
      const step1Span = stepSpans.find(s => s.span_id === getWeatherSpans[0].parent_id)
      const step2Span = stepSpans.find(s => s.span_id !== step1Span.span_id)

      const lmCall1Span = languageModelCallSpans.find(s => s.parent_id === step1Span.span_id)
      const lmCall2Span = languageModelCallSpans.find(s => s.parent_id === step2Span.span_id)

      const travelToolDefinitions = [
        {
          name: 'getWeather',
          description: 'Get current temperature and sky conditions for a city',
          schema: {
            type: 'object',
            properties: { city: { type: 'string', description: 'City name, e.g. "Miami, FL"' } },
            required: ['city'],
          },
        },
        {
          name: 'getActivities',
          description: 'Get recommended activities for a city given the current temperature',
          schema: {
            type: 'object',
            properties: {
              city: { type: 'string' },
              tempF: { type: 'number', description: 'Current temperature in Fahrenheit' },
            },
            required: ['city', 'tempF'],
          },
        },
      ]

      assertLlmObsSpanEvent(generateTextSpan, {
        span: findApmSpan(generateTextSpan),
        name: 'generateText',
        spanKind: 'workflow',
        inputValue: PROMPT,
        outputValue: MOCK_STRING,
        metadata: { temperature: 0 },
        tags: { ml_app: 'test', integration: 'ai' },
      })

      for (const stepSpan of stepSpans) {
        assertLlmObsSpanEvent(stepSpan, {
          span: findApmSpan(stepSpan),
          name: 'step',
          spanKind: 'step',
          parentId: generateTextSpan.span_id,
          tags: { ml_app: 'test', integration: 'ai' },
        })
      }

      assertLlmObsSpanEvent(lmCall1Span, {
        span: findApmSpan(lmCall1Span),
        name: 'languageModelCall',
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        parentId: step1Span.span_id,
        inputMessages: [
          {
            content: 'You are a travel assistant. Check weather for all cities before making a recommendation.',
            role: 'system',
          },
          { content: PROMPT, role: 'user' },
        ],
        outputMessages: [{
          role: 'assistant',
          tool_calls: [
            {
              name: 'getWeather',
              arguments: { city: 'New York, NY' },
              tool_id: step1ToolCalls[0].toolCallId,
              type: 'function',
            },
            {
              name: 'getWeather',
              arguments: { city: 'Miami, FL' },
              tool_id: step1ToolCalls[1].toolCallId,
              type: 'function',
            },
            {
              name: 'getWeather',
              arguments: { city: 'Seattle, WA' },
              tool_id: step1ToolCalls[2].toolCallId,
              type: 'function',
            },
          ],
        }],
        toolDefinitions: travelToolDefinitions,
        metadata: { temperature: 0 },
        metrics: {
          input_tokens: MOCK_NUMBER,
          cache_write_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: MOCK_NUMBER,
          reasoning_output_tokens: 0,
        },
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(lmCall2Span, {
        span: findApmSpan(lmCall2Span),
        name: 'languageModelCall',
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        parentId: step2Span.span_id,
        inputMessages: [
          {
            content: 'You are a travel assistant. Check weather for all cities before making a recommendation.',
            role: 'system',
          },
          { content: PROMPT, role: 'user' },
          {
            role: 'assistant',
            tool_calls: [
              {
                name: 'getWeather',
                arguments: { city: 'New York, NY' },
                tool_id: step1ToolCalls[0].toolCallId,
                type: 'function',
              },
              {
                name: 'getWeather',
                arguments: { city: 'Miami, FL' },
                tool_id: step1ToolCalls[1].toolCallId,
                type: 'function',
              },
              {
                name: 'getWeather',
                arguments: { city: 'Seattle, WA' },
                tool_id: step1ToolCalls[2].toolCallId,
                type: 'function',
              },
            ],
          },
          {
            role: 'tool',
            content: JSON.stringify({ city: 'New York, NY', tempF: 58, conditions: 'overcast' }),
            tool_id: step1ToolCalls[0].toolCallId,
          },
          {
            role: 'tool',
            content: JSON.stringify({ city: 'Miami, FL', tempF: 84, conditions: 'sunny' }),
            tool_id: step1ToolCalls[1].toolCallId,
          },
          {
            role: 'tool',
            content: JSON.stringify({ city: 'Seattle, WA', tempF: 52, conditions: 'overcast' }),
            tool_id: step1ToolCalls[2].toolCallId,
          },
        ],
        outputMessages: [{
          role: 'assistant',
          tool_calls: [
            {
              name: 'getActivities',
              arguments: { city: 'New York, NY', tempF: 58 },
              tool_id: step2ToolCalls[0].toolCallId,
              type: 'function',
            },
            {
              name: 'getActivities',
              arguments: { city: 'Miami, FL', tempF: 84 },
              tool_id: step2ToolCalls[1].toolCallId,
              type: 'function',
            },
            {
              name: 'getActivities',
              arguments: { city: 'Seattle, WA', tempF: 52 },
              tool_id: step2ToolCalls[2].toolCallId,
              type: 'function',
            },
          ],
        }],
        toolDefinitions: travelToolDefinitions,
        metadata: { temperature: 0 },
        metrics: {
          input_tokens: MOCK_NUMBER,
          cache_write_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: MOCK_NUMBER,
          reasoning_output_tokens: 0,
        },
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assert.strictEqual(getWeatherSpans.length, 3)
      assert.strictEqual(getActivitiesSpans.length, 3)

      const getWeatherByCity = city => getWeatherSpans.find(s => JSON.parse(s.meta.input.value).city === city)
      const getActivitiesByCity = city => getActivitiesSpans.find(s => JSON.parse(s.meta.input.value).city === city)

      for (const [city, tempF] of Object.entries(TEMPERATURES)) {
        const weatherSpan = getWeatherByCity(city)
        assertLlmObsSpanEvent(weatherSpan, {
          span: findApmSpan(weatherSpan),
          name: 'getWeather',
          spanKind: 'tool',
          parentId: step1Span.span_id,
          inputValue: JSON.stringify({ city }),
          outputValue: MOCK_STRING,
          tags: { ml_app: 'test', integration: 'ai' },
        })

        const activitiesSpan = getActivitiesByCity(city)
        assertLlmObsSpanEvent(activitiesSpan, {
          span: findApmSpan(activitiesSpan),
          name: 'getActivities',
          spanKind: 'tool',
          parentId: step2Span.span_id,
          inputValue: JSON.stringify({ city, tempF }),
          outputValue: MOCK_STRING,
          tags: { ml_app: 'test', integration: 'ai' },
        })
      }
    })

    it('creates spans that respects the functionId', async () => {
      await ai.generateText({
        model: openai('gpt-4o-mini'),
        instructions: 'You are a helpful assistant',
        prompt: 'Hello, OpenAI!',
        maxOutputTokens: 100,
        temperature: 0.5,
        experimental_telemetry: {
          functionId: 'test',
        },
      })

      const { apmSpans, llmobsSpans } = await getEvents(3)

      // getLlmObsSpanName prepends functionId: 'test.generateText', 'test.step', 'test.languageModelCall'
      const generateTextSpan = llmobsSpans.find(s => s.name === 'test.generateText')
      const stepSpan = llmobsSpans.find(s => s.name === 'test.step')
      const languageModelCallSpan = llmobsSpans.find(s => s.name === 'test.languageModelCall')

      const generateTextApmSpan = apmSpans.find(s => s.name === 'generateText')
      const stepApmSpan = apmSpans.find(s => s.name === 'step')
      const languageModelCallApmSpan = apmSpans.find(s => s.name === 'languageModelCall')

      assertLlmObsSpanEvent(generateTextSpan, {
        span: generateTextApmSpan,
        name: 'test.generateText',
        spanKind: 'workflow',
        inputValue: 'Hello, OpenAI!',
        outputValue: MOCK_STRING,
        metadata: {
          temperature: 0.5,
        },
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(stepSpan, {
        span: stepApmSpan,
        parentId: generateTextSpan.span_id,
        name: 'test.step',
        spanKind: 'step',
        tags: { ml_app: 'test', integration: 'ai' },
      })

      assertLlmObsSpanEvent(languageModelCallSpan, {
        span: languageModelCallApmSpan,
        parentId: stepSpan.span_id,
        spanKind: 'llm',
        modelName: 'gpt-4o-mini',
        modelProvider: 'openai',
        name: 'test.languageModelCall',
        inputMessages: [
          { content: 'You are a helpful assistant', role: 'system' },
          { content: 'Hello, OpenAI!', role: 'user' },
        ],
        outputMessages: [{ content: MOCK_STRING, role: 'assistant' }],
        metadata: {
          temperature: 0.5,
        },
        metrics: {
          input_tokens: MOCK_NUMBER,
          cache_write_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: MOCK_NUMBER,
          reasoning_output_tokens: 0,
        },
        tags: { ml_app: 'test', integration: 'ai' },
      })
    })
  })

  describe('prompt cache token capture', () => {
    function makeMockFetch (scenario) {
      const fixture = require(`../../../../../datadog-plugin-ai/test/resources/${scenario}.json`)
      return () => new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    before(() => {
      if (typeof globalThis.crypto === 'undefined') {
        globalThis.crypto = require('node:crypto').webcrypto
      }
    })

    // In v7, usage tokens are nested: usage.inputTokens.total / usage.outputTokens.total
    // All providers normalized to the sum convention (input = fresh + cached).
    // cacheWriteTokens/cacheReadTokens default to 0 (via ?? 0) when not returned by provider.
    function defaultExpectedMetrics ({ scenario }) {
      if (scenario === 'cache-read') {
        return {
          input_tokens: 4448,
          cache_read_input_tokens: 4425,
          cache_write_input_tokens: 0,
        }
      }
      if (scenario === 'cache-write') {
        return {
          input_tokens: 4448,
          cache_write_input_tokens: 4425,
          cache_read_input_tokens: 0,
        }
      }
      throw new Error(`Unknown scenario: ${scenario}`)
    }

    function describeProviderCacheTests ({
      providerName,
      packageName,
      buildModel,
      env,
      scenarios = ['cache-read', 'cache-write'],
      getExpectedMetrics = defaultExpectedMetrics,
    }) {
      describe(`${providerName}`, () => {
        if (env) useEnv(env)

        withVersions('ai', 'ai', '>=7.0.0', (version) => {
          let ai
          let PackageModule

          beforeEach(() => {
            ai = require(`../../../../../../versions/ai@${version}`).get()
            PackageModule = require(`../../../../../../versions/${packageName}`)
          })

          if (scenarios.includes('cache-read')) {
            it(`surfaces cache_read_input_tokens when ${providerName} returns cache read tokens`, async () => {
              const model = buildModel(PackageModule, 'cache-read')
              await ai.generateText({ model, prompt: 'What does Datadog LLM Observability do?' })

              const { llmobsSpans } = await getEvents()
              const languageModelCallSpan = llmobsSpans.find(s => s.name === 'languageModelCall')

              const expected = getExpectedMetrics({ scenario: 'cache-read' })
              assert.equal(languageModelCallSpan.metrics.input_tokens, expected.input_tokens)
              assert.equal(languageModelCallSpan.metrics.cache_read_input_tokens, expected.cache_read_input_tokens)
              assert.equal(languageModelCallSpan.metrics.cache_write_input_tokens, expected.cache_write_input_tokens)
            })
          }

          if (scenarios.includes('cache-write')) {
            it(`surfaces cache_write_input_tokens when ${providerName} returns cache write tokens`, async () => {
              const model = buildModel(PackageModule, 'cache-write')
              await ai.generateText({ model, prompt: 'What does Datadog LLM Observability do?' })

              const { llmobsSpans } = await getEvents()
              const languageModelCallSpan = llmobsSpans.find(s => s.name === 'languageModelCall')

              const expected = getExpectedMetrics({ scenario: 'cache-write' })
              assert.equal(languageModelCallSpan.metrics.input_tokens, expected.input_tokens)
              assert.equal(languageModelCallSpan.metrics.cache_write_input_tokens, expected.cache_write_input_tokens)
              assert.equal(languageModelCallSpan.metrics.cache_read_input_tokens, expected.cache_read_input_tokens)
            })
          }
        })
      })
    }

    describeProviderCacheTests({
      providerName: 'Bedrock',
      packageName: '@ai-sdk/amazon-bedrock',
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
      packageName: '@ai-sdk/anthropic',
      buildModel: (AnthropicModule, scenario) => {
        const { createAnthropic } = AnthropicModule.get()
        return createAnthropic({
          apiKey: 'test-api-key',
          fetch: makeMockFetch(`anthropic-${scenario}`),
        })('claude-3-5-haiku-20241022')
      },
    })

    const openaiExpectedMetrics = ({ scenario }) => {
      if (scenario === 'cache-read') {
        return {
          input_tokens: 4448,
          cache_read_input_tokens: 4425,
          cache_write_input_tokens: 0,
        }
      }
      throw new Error(`OpenAI does not support scenario: ${scenario}`)
    }

    describeProviderCacheTests({
      providerName: 'OpenAI (Chat Completions)',
      packageName: '@ai-sdk/openai',
      buildModel: (OpenAiModule, scenario) => {
        const { createOpenAI } = OpenAiModule.get()
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
      packageName: '@ai-sdk/openai',
      buildModel: (OpenAiModule, scenario) => {
        const { createOpenAI } = OpenAiModule.get()
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
      packageName: '@ai-sdk/google',
      buildModel: (GoogleModule, scenario) => {
        const { createGoogleGenerativeAI } = GoogleModule.get()
        return createGoogleGenerativeAI({
          apiKey: 'test-api-key',
          fetch: makeMockFetch(`google-${scenario}`),
        })('gemini-2.5-flash')
      },
      scenarios: ['cache-read'],
      getExpectedMetrics: ({ scenario }) => {
        if (scenario === 'cache-read') {
          return {
            input_tokens: 4448,
            cache_read_input_tokens: 4425,
            cache_write_input_tokens: 0,
          }
        }
        throw new Error(`Google does not support scenario: ${scenario}`)
      },
    })
  })
})
