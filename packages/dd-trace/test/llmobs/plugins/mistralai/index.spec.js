'use strict'

const assert = require('node:assert')
const { describe, before, it } = require('mocha')
const { withVersions } = require('../../../setup/mocha')
const { useEnv } = require('../../../../../../integration-tests/helpers')

const {
  useLlmObs,
  MOCK_STRING,
  MOCK_NUMBER,
  assertLlmObsSpanEvent,
} = require('../../util')

const WEATHER_TOOLS = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a location.',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
    },
  },
}]

const WEATHER_TOOL_DEFINITIONS = [{
  name: 'get_weather',
  description: 'Get the current weather for a location.',
  schema: {
    type: 'object',
    properties: { location: { type: 'string' } },
    required: ['location'],
  },
}]

const CHAT_REQUEST = {
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 100,
  randomSeed: 42,
  presencePenalty: 0,
  frequencyPenalty: 0,
}

const CHAT_METADATA = {
  temperature: 0.7,
  top_p: 0.9,
  max_tokens: 100,
  random_seed: 42,
  presence_penalty: 0,
  frequency_penalty: 0,
}

const TAGS = { ml_app: 'test', integration: 'mistralai' }

describe('Plugin', () => {
  useEnv({
    MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '<not-a-real-key>',
  })

  const { getEvents } = useLlmObs({ plugin: 'mistralai' })

  withVersions('mistralai', '@mistralai/mistralai', (version) => {
    let Mistral
    let client

    before(() => {
      Mistral = require(`../../../../../../versions/@mistralai/mistralai@${version}`).get().Mistral
      client = new Mistral({ serverURL: 'http://127.0.0.1:9126/vcr/mistral', retryConfig: { strategy: 'none' } })
    })

    describe('chat.complete', () => {
      it('creates an llm span', async () => {
        await client.chat.complete({
          model: 'mistral-large-latest',
          messages: [{ role: 'user', content: 'Why is the sky blue?' }],
          ...CHAT_REQUEST,
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'mistralai.request',
          modelName: 'mistral-large-latest',
          modelProvider: 'mistral',
          inputMessages: [{ role: 'user', content: 'Why is the sky blue?' }],
          outputMessages: [{ role: 'assistant', content: MOCK_STRING }],
          metadata: CHAT_METADATA,
          metrics: { input_tokens: 9, output_tokens: 100, total_tokens: 109 },
          tags: TAGS,
        })
      })

      it('creates an llm span with tool calls and tool definitions', async () => {
        await client.chat.complete({
          model: 'mistral-large-latest',
          messages: [{ role: 'user', content: "What's the weather in NYC?" }],
          tools: WEATHER_TOOLS,
          ...CHAT_REQUEST,
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'mistralai.request',
          modelName: 'mistral-large-latest',
          modelProvider: 'mistral',
          inputMessages: [{ role: 'user', content: "What's the weather in NYC?" }],
          outputMessages: [{
            role: 'assistant',
            content: '',
            tool_calls: [{
              name: 'get_weather',
              arguments: { location: 'New York City' },
              tool_id: MOCK_STRING,
              type: 'function',
            }],
          }],
          metadata: CHAT_METADATA,
          metrics: { input_tokens: 72, output_tokens: 14, total_tokens: 86 },
          toolDefinitions: WEATHER_TOOL_DEFINITIONS,
          tags: TAGS,
        })
      })

      it('creates an llm span with tool call and tool result input messages', async () => {
        const toolResult = { location: 'New York, NY', temperature: 72, unit: 'fahrenheit', forecast: 'Sunny' }

        await client.chat.complete({
          model: 'mistral-large-latest',
          messages: [
            { role: 'user', content: "What's the weather in NYC?" },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'Caf7Pyrd8',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"location": "New York City"}' },
              }],
            },
            { role: 'tool', name: 'get_weather', toolCallId: 'Caf7Pyrd8', content: JSON.stringify(toolResult) },
          ],
          tools: WEATHER_TOOLS,
          ...CHAT_REQUEST,
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'mistralai.request',
          modelName: 'mistral-large-latest',
          modelProvider: 'mistral',
          inputMessages: [
            { role: 'user', content: "What's the weather in NYC?" },
            {
              role: 'assistant',
              content: '',
              tool_calls: [{
                name: 'get_weather',
                arguments: { location: 'New York City' },
                tool_id: 'Caf7Pyrd8',
                type: 'function',
              }],
            },
            { role: 'tool', content: JSON.stringify(toolResult) },
          ],
          outputMessages: [{ role: 'assistant', content: MOCK_STRING }],
          metadata: CHAT_METADATA,
          metrics: { input_tokens: 118, output_tokens: 32, total_tokens: 150 },
          toolDefinitions: WEATHER_TOOL_DEFINITIONS,
          tags: TAGS,
        })
      })

      it('creates an llm span with a reasoning output message', async () => {
        await client.chat.complete({
          model: 'magistral-medium-latest',
          messages: [{ role: 'user', content: 'What is 2+2?' }],
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 500,
          randomSeed: 42,
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'mistralai.request',
          modelName: 'magistral-medium-latest',
          modelProvider: 'mistral',
          inputMessages: [{ role: 'user', content: 'What is 2+2?' }],
          outputMessages: [
            { role: 'reasoning', content: MOCK_STRING },
            { role: 'assistant', content: MOCK_STRING },
          ],
          metadata: { temperature: 0.7, top_p: 0.9, max_tokens: 500, random_seed: 42 },
          metrics: { input_tokens: 10, output_tokens: 63, total_tokens: 73 },
          tags: TAGS,
        })
      })

      it('creates an llm span with an error', async () => {
        let error
        try {
          await client.chat.complete({
            model: 'invalid-model',
            messages: [{ role: 'user', content: 'Why is the sky blue?' }],
            ...CHAT_REQUEST,
          })
        } catch (e) {
          error = e
        }
        assert.ok(error, 'expected chat.complete to reject')

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'mistralai.request',
          modelName: 'invalid-model',
          modelProvider: 'mistral',
          inputMessages: [{ role: 'user', content: 'Why is the sky blue?' }],
          outputMessages: [{ role: 'assistant', content: '' }],
          metadata: CHAT_METADATA,
          tags: TAGS,
          error: {
            type: error.name,
            message: error.message,
            stack: error.stack,
          },
        })
      })

      it('sets model_provider to unknown for unrecognized server URLs', async () => {
        const customClient = new Mistral({ serverURL: 'http://127.0.0.1:1', retryConfig: { strategy: 'none' } })

        await assert.rejects(customClient.chat.complete({
          model: 'mistral-large-latest',
          messages: [{ role: 'user', content: 'Why is the sky blue?' }],
        }))

        const { llmobsSpans } = await getEvents()
        assert.strictEqual(llmobsSpans[0].meta.model_provider, 'unknown')
      })
    })

    describe('chat.stream', () => {
      it('creates an llm span from aggregated chunks', async () => {
        const stream = await client.chat.stream({
          model: 'mistral-large-latest',
          messages: [{ role: 'user', content: 'Why is the sky blue?' }],
          ...CHAT_REQUEST,
        })

        let chunks = 0
        for await (const chunk of stream) {
          assert.ok(chunk.data)
          chunks++
        }
        assert.ok(chunks > 1, 'expected more than one streamed chunk')

        const { apmSpans, llmobsSpans } = await getEvents()

        const content = llmobsSpans[0].meta.output.messages[0].content
        assert.ok(content.length > 20, `expected aggregated stream content, got ${JSON.stringify(content)}`)

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'mistralai.request',
          modelName: 'mistral-large-latest',
          modelProvider: 'mistral',
          inputMessages: [{ role: 'user', content: 'Why is the sky blue?' }],
          outputMessages: [{ role: 'assistant', content: MOCK_STRING }],
          metadata: CHAT_METADATA,
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
          tags: TAGS,
        })
      })

      it('creates an llm span with aggregated tool calls', async () => {
        const stream = await client.chat.stream({
          model: 'mistral-large-latest',
          messages: [{ role: 'user', content: "What's the weather in NYC?" }],
          tools: WEATHER_TOOLS,
          ...CHAT_REQUEST,
        })

        for await (const chunk of stream) {
          assert.ok(chunk.data)
        }

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'mistralai.request',
          modelName: 'mistral-large-latest',
          modelProvider: 'mistral',
          inputMessages: [{ role: 'user', content: "What's the weather in NYC?" }],
          outputMessages: [{
            role: 'assistant',
            content: '',
            tool_calls: [{
              name: 'get_weather',
              arguments: { location: 'New York City' },
              tool_id: MOCK_STRING,
              type: 'function',
            }],
          }],
          metadata: CHAT_METADATA,
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
          toolDefinitions: WEATHER_TOOL_DEFINITIONS,
          tags: TAGS,
        })
      })

      it('creates an llm span with an aggregated reasoning message', async () => {
        const stream = await client.chat.stream({
          model: 'magistral-medium-latest',
          messages: [{ role: 'user', content: 'What is 2+2?' }],
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 500,
          randomSeed: 42,
        })

        for await (const chunk of stream) {
          assert.ok(chunk.data)
        }

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'mistralai.request',
          modelName: 'magistral-medium-latest',
          modelProvider: 'mistral',
          inputMessages: [{ role: 'user', content: 'What is 2+2?' }],
          outputMessages: [
            { role: 'reasoning', content: MOCK_STRING },
            { role: 'assistant', content: MOCK_STRING },
          ],
          metadata: { temperature: 0.7, top_p: 0.9, max_tokens: 500, random_seed: 42 },
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: MOCK_NUMBER, total_tokens: MOCK_NUMBER },
          tags: TAGS,
        })
      })
    })

    describe('embeddings.create', () => {
      it('creates an embedding span for a single input', async () => {
        await client.embeddings.create({
          model: 'mistral-embed',
          inputs: 'Hello world',
          encodingFormat: 'float',
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'embedding',
          name: 'mistralai.request',
          modelName: 'mistral-embed',
          modelProvider: 'mistral',
          inputDocuments: [{ text: 'Hello world' }],
          outputValue: '[1 embedding(s) returned with size 1024]',
          metadata: { encoding_format: 'float' },
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: 0, total_tokens: MOCK_NUMBER },
          tags: TAGS,
        })
      })

      it('creates an embedding span for multiple inputs', async () => {
        await client.embeddings.create({
          model: 'mistral-embed',
          inputs: ['Why is the sky blue?', 'What is your age?'],
          encodingFormat: 'float',
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'embedding',
          name: 'mistralai.request',
          modelName: 'mistral-embed',
          modelProvider: 'mistral',
          inputDocuments: [{ text: 'Why is the sky blue?' }, { text: 'What is your age?' }],
          outputValue: '[2 embedding(s) returned with size 1024]',
          metadata: { encoding_format: 'float' },
          metrics: { input_tokens: MOCK_NUMBER, output_tokens: 0, total_tokens: MOCK_NUMBER },
          tags: TAGS,
        })
      })
    })
  })
})
