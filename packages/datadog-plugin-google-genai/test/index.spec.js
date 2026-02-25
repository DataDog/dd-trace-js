'use strict'

const assert = require('node:assert')
const { describe, before, after, it } = require('mocha')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  withVersions('google-genai', '@google/genai', (version) => {
    let client

    before(async () => {
      await agent.load('google-genai')

      const { GoogleGenAI } = require(`../../../versions/@google/genai@${version}`).get()
      client = new GoogleGenAI({
        apiKey: process.env.GOOGLE_API_KEY || '<not-a-real-key>',
        httpOptions: { baseUrl: 'http://127.0.0.1:9126/vcr/genai' },
      })
    })

    after(async () => {
      await agent.close({ ritmReset: false })
    })

    describe('models.generateContent', () => {
      it('creates a span', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.equal(span.name, 'google_genai.request')
          assert.equal(span.resource, 'Models.generate_content')
          assert.equal(span.meta['google_genai.request.model'], 'gemini-2.0-flash')
        })

        const result = await client.models.generateContent({
          model: 'gemini-2.0-flash',
          contents: 'Hello, world!',
        })

        assert.ok(result)

        await tracesPromise
      })
    })

    describe('models.generateContentStream', () => {
      it('creates a span', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.equal(span.name, 'google_genai.request')
          assert.equal(span.resource, 'Models.generate_content_stream')
          assert.equal(span.meta['google_genai.request.model'], 'gemini-2.0-flash')
        })

        const stream = await client.models.generateContentStream({
          model: 'gemini-2.0-flash',
          contents: 'Hello, world!',
        })

        for await (const chunk of stream) {
          assert.ok(chunk)
        }

        await tracesPromise
      })
    })

    describe('models.embedContent', () => {
      it('creates a span', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assert.equal(span.name, 'google_genai.request')
          assert.equal(span.resource, 'Models.embed_content')
          assert.equal(span.meta['google_genai.request.model'], 'text-embedding-004')
        })

        const result = await client.models.embedContent({
          model: 'text-embedding-004',
          contents: 'Hello, world!',
        })

        assert.ok(result)

        await tracesPromise
      })
    })
  })
})
