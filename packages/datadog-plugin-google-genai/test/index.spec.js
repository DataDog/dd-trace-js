'use strict'

const http = require('http')
const { describe, before, after, it } = require('mocha')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const assert = require('node:assert')
const { useEnv } = require('../../../integration-tests/helpers')

const generateContentResponse = {
  candidates: [{
    content: {
      parts: [{ text: 'Hello! How can I help you today?' }],
      role: 'model'
    },
    finishReason: 'STOP'
  }],
  usageMetadata: {
    promptTokenCount: 5,
    candidatesTokenCount: 10,
    totalTokenCount: 15
  },
  modelVersion: 'gemini-2.0-flash'
}

const embedContentResponse = {
  embedding: {
    values: Array(768).fill(0.1)
  }
}

function createMockServer (port, callback) {
  const server = http.createServer((req, res) => {
    // Consume request body
    req.on('data', () => {})
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')

      // Handle all API endpoints
      if (req.url.includes(':embedContent')) {
        res.end(JSON.stringify(embedContentResponse))
      } else if (req.url.includes(':streamGenerateContent')) {
        // Google GenAI streaming uses Server-Sent Events format
        res.setHeader('Content-Type', 'text/event-stream')
        res.write('data: ' + JSON.stringify(generateContentResponse) + '\n\n')
        res.end()
      } else if (req.url.includes(':generateContent')) {
        res.end(JSON.stringify(generateContentResponse))
      } else {
        // Default response for any other endpoint
        res.end(JSON.stringify(generateContentResponse))
      }
    })
  })

  server.listen(port, '127.0.0.1', () => callback(server))
  return server
}

describe('Plugin', () => {
  useEnv({
    GOOGLE_API_KEY: '<not-a-real-key>'
  })

  withVersions('google-genai', '@google/genai', (version) => {
    let client
    let mockServer
    let mockPort

    before(async () => {
      await agent.load('google-genai')

      // Find an available port and start mock server
      await new Promise((resolve) => {
        mockServer = createMockServer(0, (server) => {
          mockPort = server.address().port
          resolve()
        })
      })

      const { GoogleGenAI } = require(`../../../versions/@google/genai@${version}`).get()
      client = new GoogleGenAI({
        apiKey: '<not-a-real-key>',
        httpOptions: { baseUrl: `http://127.0.0.1:${mockPort}` }
      })
    })

    after(async () => {
      if (mockServer) {
        mockServer.close()
      }
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
          contents: 'Hello, world!'
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
          contents: 'Hello, world!'
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
          contents: 'Hello, world!'
        })

        assert.ok(result)

        await tracesPromise
      })
    })
  })
})
