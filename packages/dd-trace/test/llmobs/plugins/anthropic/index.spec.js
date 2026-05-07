'use strict'

const assert = require('node:assert')
const { describe, before, it } = require('mocha')
const semifies = require('semifies')
const { withVersions } = require('../../../setup/mocha')
const { useEnv } = require('../../../../../../integration-tests/helpers')

const {
  useLlmObs,
  MOCK_STRING,
  MOCK_NUMBER,
  assertLlmObsSpanEvent,
} = require('../../util')

function assertLLMObsSpan (apmSpans, llmobsSpans) {
  assertLlmObsSpanEvent(llmobsSpans[0], {
    span: apmSpans[0],
    spanKind: 'llm',
    name: 'anthropic.request',
    modelName: 'claude-3-7-sonnet-20250219',
    modelProvider: 'anthropic',
    inputMessages: [{ role: 'user', content: 'Hello, world!' }],
    outputMessages: [{ role: 'assistant', content: MOCK_STRING }],
    metadata: {
      max_tokens: 100,
      temperature: 0.5,
    },
    metrics: {
      input_tokens: MOCK_NUMBER,
      output_tokens: MOCK_NUMBER,
      total_tokens: MOCK_NUMBER,
      cache_write_input_tokens: MOCK_NUMBER,
      cache_read_input_tokens: MOCK_NUMBER,
      ephemeral_5m_input_tokens: MOCK_NUMBER,
      ephemeral_1h_input_tokens: MOCK_NUMBER,
    },
    tags: { ml_app: 'test', integration: 'anthropic' },
  })
}

describe('Plugin', () => {
  useEnv({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '<not-a-real-key>',
  })

  const { getEvents } = useLlmObs({ plugin: 'anthropic' })

  withVersions('anthropic', '@anthropic-ai/sdk', (version, moduleName, realVersion) => {
    let client

    before(() => {
      const { Anthropic } = require(`../../../../../../versions/@anthropic-ai/sdk@${version}`).get()
      client = new Anthropic({ baseURL: 'http://127.0.0.1:9126/vcr/anthropic' })
    })

    const isBetaSupported = semifies(realVersion, '>=0.33.0')

    describe('messages.create', () => {
      it('creates a span', async () => {
        await client.messages.create({
          model: 'claude-3-7-sonnet-20250219',
          messages: [{ role: 'user', content: 'Hello, world!' }],
          max_tokens: 100,
          temperature: 0.5,
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLLMObsSpan(apmSpans, llmobsSpans)
      })

      it('sets model_provider to unknown for unrecognized base URLs', async () => {
        const { Anthropic } = require(`../../../../../../versions/@anthropic-ai/sdk@${version}`).get()
        const customClient = new Anthropic({ baseURL: 'http://localhost:8000' })

        try {
          await customClient.messages.create({
            model: 'claude-3-7-sonnet-20250219',
            messages: [{ role: 'user', content: 'Hello, world!' }],
            max_tokens: 100,
            temperature: 0.5,
          })
        } catch {
          // expected error — no server is running
        }

        const { llmobsSpans } = await getEvents()

        assert.equal(llmobsSpans[0].meta.model_provider, 'unknown', 'Model provider does not match')
      })

      describe('stream', () => {
        it('creates a span', async () => {
          const stream = await client.messages.create({
            model: 'claude-3-7-sonnet-20250219',
            messages: [{ role: 'user', content: 'Hello, world!' }],
            max_tokens: 100,
            temperature: 0.5,
            stream: true,
          })

          for await (const chunk of stream) {
            assert.ok(chunk)
          }

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLLMObsSpan(apmSpans, llmobsSpans)
        })
      })

      it('does not modify the `system` property', async () => {
        const params = Object.freeze({
          model: 'claude-haiku-4-5-20251001',
          messages: Object.freeze([Object.freeze({ role: 'user', content: 'Hello, world!' })]),
          max_tokens: 100,
          temperature: 0.5,
          system: 'talk like a pirate',
        })

        const response = await client.messages.create(params)

        assert.deepEqual(params.messages, [{ role: 'user', content: 'Hello, world!' }])
        assert.ok(response)

        const { llmobsSpans } = await getEvents()
        assert.equal(llmobsSpans.length, 1)

        assert.deepEqual(llmobsSpans[0].meta.input.messages, [
          { role: 'system', content: 'talk like a pirate' },
          { role: 'user', content: 'Hello, world!' },
        ])
      })
    })

    describe('messages.stream', () => {
      it('creates a span for async iterator consumption', async () => {
        const stream = client.messages.stream({
          model: 'claude-3-7-sonnet-20250219',
          messages: [{ role: 'user', content: 'Hello, world!' }],
          max_tokens: 100,
          temperature: 0.5,
        })

        for await (const chunk of stream) {
          assert.ok(chunk)
        }

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLLMObsSpan(apmSpans, llmobsSpans)
      })

      describe('when using streaming helper methods', () => {
        it('creates a span for stream.on', async () => {
          client.messages.stream({
            model: 'claude-3-7-sonnet-20250219',
            messages: [{ role: 'user', content: 'Hello, world!' }],
            max_tokens: 100,
            temperature: 0.5,
          }).on('text', text => {
            assert.ok(text)
          })

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLLMObsSpan(apmSpans, llmobsSpans)
        })

        it('creates a span for stream.finalMessage', async () => {
          const stream = client.messages.stream({
            model: 'claude-3-7-sonnet-20250219',
            messages: [{ role: 'user', content: 'Hello, world!' }],
            max_tokens: 100,
            temperature: 0.5,
            stream: true,
          })

          const message = await stream.finalMessage()
          assert.ok(message)

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLLMObsSpan(apmSpans, llmobsSpans)
        })
      })
    })

    describe('extended thinking', () => {
      const WEATHER_PROMPT = 'What is the weather in San Francisco, CA?'
      const tools = [{
        name: 'get_weather',
        description: 'Get the weather for a specific location',
        input_schema: {
          type: 'object',
          properties: { location: { type: 'string' } },
        },
      }]

      it('captures thinking blocks as reasoning messages (non-streaming)', async () => {
        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'What is the best selling book of all time?' }],
          max_tokens: 16000,
          temperature: 1,
          thinking: { type: 'enabled', budget_tokens: 1024 },
        })

        assert.ok(response)

        const { apmSpans, llmobsSpans } = await getEvents()
        assert.ok(!llmobsSpans[0].meta.output.messages[0].content.includes('signature'))

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'anthropic.request',
          modelName: 'claude-haiku-4-5-20251001',
          modelProvider: 'anthropic',
          inputMessages: [{ role: 'user', content: 'What is the best selling book of all time?' }],
          outputMessages: [
            { role: 'reasoning', content: MOCK_STRING },
            { role: 'assistant', content: MOCK_STRING },
          ],
          metadata: {
            max_tokens: 16000,
            temperature: 1,
          },
          metrics: {
            input_tokens: MOCK_NUMBER,
            output_tokens: MOCK_NUMBER,
            total_tokens: MOCK_NUMBER,
            cache_write_input_tokens: MOCK_NUMBER,
            cache_read_input_tokens: MOCK_NUMBER,
            ephemeral_5m_input_tokens: MOCK_NUMBER,
            ephemeral_1h_input_tokens: MOCK_NUMBER,
          },
          tags: { ml_app: 'test', integration: 'anthropic' },
        })
      })

      it('captures thinking blocks as reasoning messages (streaming)', async () => {
        const stream = client.messages.stream({
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: 'What is the best selling book of all time?' }],
          max_tokens: 16000,
          temperature: 1,
          thinking: { type: 'enabled', budget_tokens: 1024 },
        })

        for await (const chunk of stream) {
          assert.ok(chunk)
        }

        const message = await stream.finalMessage()
        assert.ok(message)

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'anthropic.request',
          modelName: 'claude-haiku-4-5-20251001',
          modelProvider: 'anthropic',
          inputMessages: [{ role: 'user', content: 'What is the best selling book of all time?' }],
          outputMessages: [
            { role: 'reasoning', content: MOCK_STRING },
            { role: 'assistant', content: MOCK_STRING },
          ],
          metadata: {
            max_tokens: 16000,
            temperature: 1,
          },
          metrics: {
            input_tokens: MOCK_NUMBER,
            output_tokens: MOCK_NUMBER,
            total_tokens: MOCK_NUMBER,
            cache_write_input_tokens: MOCK_NUMBER,
            cache_read_input_tokens: MOCK_NUMBER,
            ephemeral_5m_input_tokens: MOCK_NUMBER,
            ephemeral_1h_input_tokens: MOCK_NUMBER,
          },
          tags: { ml_app: 'test', integration: 'anthropic' },
        })
      })

      it('captures thinking + tool_use blocks correctly', async () => {
        await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: WEATHER_PROMPT }],
          max_tokens: 16000,
          temperature: 1,
          thinking: { type: 'enabled', budget_tokens: 1024 },
          tools,
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'anthropic.request',
          modelName: 'claude-haiku-4-5-20251001',
          modelProvider: 'anthropic',
          inputMessages: [{ role: 'user', content: WEATHER_PROMPT }],
          outputMessages: [
            { role: 'reasoning', content: MOCK_STRING },
            {
              role: 'assistant',
              content: '',
              tool_calls: [{
                name: 'get_weather',
                arguments: { location: MOCK_STRING },
                tool_id: MOCK_STRING,
                type: 'tool_use',
              }],
            },
          ],
          metadata: {
            max_tokens: 16000,
            temperature: 1,
          },
          metrics: {
            input_tokens: MOCK_NUMBER,
            output_tokens: MOCK_NUMBER,
            total_tokens: MOCK_NUMBER,
            cache_write_input_tokens: MOCK_NUMBER,
            cache_read_input_tokens: MOCK_NUMBER,
            ephemeral_5m_input_tokens: MOCK_NUMBER,
            ephemeral_1h_input_tokens: MOCK_NUMBER,
          },
          tags: { ml_app: 'test', integration: 'anthropic' },
        })
      })

      it('captures thinking blocks in input messages (tool use continuation)', async function () {
        // The Anthropic API rejects fake `signature` values on thinking blocks, so we
        // must first make a real call to obtain a valid thinking block + signature,
        // then echo it back in a continuation request.
        const firstResponse = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: WEATHER_PROMPT }],
          max_tokens: 16000,
          temperature: 1,
          thinking: { type: 'enabled', budget_tokens: 1024 },
          tools,
        })

        const thinkingBlock = firstResponse.content.find(b => b.type === 'thinking')
        const toolUseBlock = firstResponse.content.find(b => b.type === 'tool_use')

        // Discard the first call's events so we only assert against the continuation span.
        await getEvents()

        await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          messages: [
            { role: 'user', content: WEATHER_PROMPT },
            { role: 'assistant', content: [thinkingBlock, toolUseBlock] },
            {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: toolUseBlock.id,
                content: [{ type: 'text', text: 'The weather is 73f' }],
              }],
            },
          ],
          max_tokens: 16000,
          temperature: 1,
          thinking: { type: 'enabled', budget_tokens: 1024 },
          tools,
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'anthropic.request',
          modelName: 'claude-haiku-4-5-20251001',
          modelProvider: 'anthropic',
          inputMessages: [
            { role: 'user', content: WEATHER_PROMPT },
            { role: 'reasoning', content: thinkingBlock.thinking },
            {
              role: 'assistant',
              content: '',
              tool_calls: [{
                name: 'get_weather',
                arguments: toolUseBlock.input,
                tool_id: toolUseBlock.id,
                type: 'tool_use',
              }],
            },
            {
              role: 'user',
              content: '',
              tool_results: [{
                name: '',
                result: 'The weather is 73f',
                tool_id: toolUseBlock.id,
                type: 'tool_result',
              }],
            },
          ],
          outputMessages: [{ role: 'assistant', content: MOCK_STRING }],
          metadata: {
            max_tokens: 16000,
            temperature: 1,
          },
          metrics: {
            input_tokens: MOCK_NUMBER,
            output_tokens: MOCK_NUMBER,
            total_tokens: MOCK_NUMBER,
            cache_write_input_tokens: MOCK_NUMBER,
            cache_read_input_tokens: MOCK_NUMBER,
            ephemeral_5m_input_tokens: MOCK_NUMBER,
            ephemeral_1h_input_tokens: MOCK_NUMBER,
          },
          tags: { ml_app: 'test', integration: 'anthropic' },
        })
      })
    })

    describe('beta.messages.create', () => {
      before(function () {
        if (!isBetaSupported) this.skip()
      })

      it('creates a span', async () => {
        await client.beta.messages.create({
          model: 'claude-3-7-sonnet-20250219',
          messages: [{ role: 'user', content: 'Hello, world!' }],
          max_tokens: 100,
          temperature: 0.5,
        })

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLLMObsSpan(apmSpans, llmobsSpans)
      })

      describe('stream', () => {
        it('creates a span', async () => {
          const stream = await client.beta.messages.create({
            model: 'claude-3-7-sonnet-20250219',
            messages: [{ role: 'user', content: 'Hello, world!' }],
            max_tokens: 100,
            temperature: 0.5,
            stream: true,
          })

          for await (const chunk of stream) {
            assert.ok(chunk)
          }

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLLMObsSpan(apmSpans, llmobsSpans)
        })
      })
    })

    describe('beta.messages.stream', () => {
      before(function () {
        // stream helper was added in 0.35.0
        if (!isBetaSupported || !client.beta?.messages?.stream) this.skip()
      })

      it('creates a span for async iterator consumption', async () => {
        const stream = client.beta.messages.stream({
          model: 'claude-3-7-sonnet-20250219',
          messages: [{ role: 'user', content: 'Hello, world!' }],
          max_tokens: 100,
          temperature: 0.5,
        })

        for await (const chunk of stream) {
          assert.ok(chunk)
        }

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLLMObsSpan(apmSpans, llmobsSpans)
      })
    })
  })
})
