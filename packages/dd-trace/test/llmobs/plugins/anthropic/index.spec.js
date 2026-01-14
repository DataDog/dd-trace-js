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
  assertLlmObsSpanEvent
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
      cache_read_input_tokens: MOCK_NUMBER
    },
    tags: { ml_app: 'test', integration: 'anthropic' },
  })
}

describe('Plugin', () => {
  useEnv({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '<not-a-real-key>'
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

      describe('stream', () => {
        it('creates a span', async () => {
          const stream = await client.messages.create({
            model: 'claude-3-7-sonnet-20250219',
            messages: [{ role: 'user', content: 'Hello, world!' }],
            max_tokens: 100,
            temperature: 0.5,
            stream: true
          })

          for await (const chunk of stream) {
            assert.ok(chunk)
          }

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLLMObsSpan(apmSpans, llmobsSpans)
        })
      })
    })

    describe('messages.stream', () => {
      it('creates a span for async iterator consumption', async () => {
        const stream = client.messages.stream({
          model: 'claude-3-7-sonnet-20250219',
          messages: [{ role: 'user', content: 'Hello, world!' }],
          max_tokens: 100,
          temperature: 0.5
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
            temperature: 0.5
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
            stream: true
          })

          const message = await stream.finalMessage()
          assert.ok(message)

          const { apmSpans, llmobsSpans } = await getEvents()
          assertLLMObsSpan(apmSpans, llmobsSpans)
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
            stream: true
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
          temperature: 0.5
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
