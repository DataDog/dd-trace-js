'use strict'

const assert = require('node:assert')
const { describe, before, after, it } = require('mocha')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { useEnv } = require('../../../integration-tests/helpers')

const CHAT_REQUEST = {
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 100,
  randomSeed: 42,
  presencePenalty: 0,
  frequencyPenalty: 0,
}

describe('Plugin', () => {
  useEnv({
    MISTRAL_API_KEY: '<not-a-real-key>',
  })

  withVersions('mistralai', '@mistralai/mistralai', (version) => {
    let client

    before(async () => {
      await agent.load('mistralai')

      const { Mistral } = require(`../../../versions/@mistralai/mistralai@${version}`).get()
      client = new Mistral({ serverURL: 'http://127.0.0.1:9126/vcr/mistral', retryConfig: { strategy: 'none' } })
    })

    after(() => agent.close())

    describe('chat.complete', () => {
      it('creates a span', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.equal(span.name, 'mistralai.request')
          assert.equal(span.resource, 'Chat.complete')
          assert.equal(span.meta['mistralai.request.model'], 'mistral-large-latest')
          assert.equal(span.meta['mistralai.request.provider'], 'mistral')
          assert.equal(span.error, 0)
        })

        const result = await client.chat.complete({
          model: 'mistral-large-latest',
          messages: [{ role: 'user', content: 'Why is the sky blue?' }],
          ...CHAT_REQUEST,
        })
        assert.ok(result)

        await tracesPromise
      })

      it('tags the span with an error when the request fails', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.equal(span.name, 'mistralai.request')
          assert.equal(span.resource, 'Chat.complete')
          assert.equal(span.error, 1)
          assert.ok(span.meta['error.type'])
          assert.ok(span.meta['error.message'])
        })

        await assert.rejects(client.chat.complete({
          model: 'invalid-model',
          messages: [{ role: 'user', content: 'Why is the sky blue?' }],
          ...CHAT_REQUEST,
        }))

        await tracesPromise
      })
    })

    describe('chat.stream', () => {
      it('creates a span that finishes when the stream is consumed', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.equal(span.name, 'mistralai.request')
          assert.equal(span.resource, 'Chat.stream')
          assert.equal(span.meta['mistralai.request.model'], 'mistral-large-latest')
          assert.equal(span.error, 0)
        })

        const stream = await client.chat.stream({
          model: 'mistral-large-latest',
          messages: [{ role: 'user', content: 'Why is the sky blue?' }],
          ...CHAT_REQUEST,
        })

        let chunks = 0
        for await (const chunk of stream) {
          assert.ok(chunk)
          chunks++
        }
        assert.ok(chunks > 1, 'expected more than one streamed chunk')

        await tracesPromise
      })
    })

    describe('embeddings.create', () => {
      it('creates a span', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.equal(span.name, 'mistralai.request')
          assert.equal(span.resource, 'Embeddings.create')
          assert.equal(span.meta['mistralai.request.model'], 'mistral-embed')
          assert.equal(span.meta['mistralai.request.provider'], 'mistral')
        })

        const result = await client.embeddings.create({
          model: 'mistral-embed',
          inputs: 'Hello, world!',
          encodingFormat: 'float',
        })
        assert.ok(result)

        await tracesPromise
      })
    })
  })
})
