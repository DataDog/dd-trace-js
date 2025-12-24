'use strict'

const { describe, before, it } = require('mocha')
const { withVersions } = require('../../../setup/mocha')
const assert = require('node:assert')

const {
  useLlmObs,
  MOCK_STRING,
  MOCK_NUMBER,
  assertLlmObsSpanEvent
} = require('../../util')

describe('Plugin', () => {
  const getEvents = useLlmObs({ plugin: 'google-genai' })

  withVersions('google-genai', '@google/genai', (version) => {
    let client

    before(async () => {
      const { GoogleGenAI } = require(`../../../../../../versions/@google/genai@${version}`).get()
      client = new GoogleGenAI({
        apiKey: process.env.GOOGLE_API_KEY || '<not-a-real-key>',
        httpOptions: { baseUrl: 'http://127.0.0.1:9126/vcr/genai' }
      })
    })

    describe('models.generateContent', () => {
      it('creates a span', async () => {
        const result = await client.models.generateContent({
          model: 'gemini-2.0-flash',
          contents: 'Hello, world!'
        })

        assert.ok(result)

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'google_genai.request',
          modelName: 'gemini-2.0-flash',
          modelProvider: 'google',
          inputMessages: [{ role: 'user', content: 'Hello, world!' }],
          outputMessages: [{ role: 'assistant', content: MOCK_STRING }],
          metadata: {
            temperature: null,
            top_p: null,
            top_k: null,
            candidate_count: null,
            max_output_tokens: null,
            stop_sequences: null,
            response_logprobs: null,
            logprobs: null,
            presence_penalty: null,
            frequency_penalty: null,
            seed: null,
            response_mime_type: null,
            safety_settings: null,
            automatic_function_calling: null
          },
          metrics: {
            input_tokens: MOCK_NUMBER,
            output_tokens: MOCK_NUMBER,
            total_tokens: MOCK_NUMBER,
          },
          tags: { ml_app: 'test', integration: 'google_genai' },
        })
      })
    })

    describe('models.generateContentStream', () => {
      it('creates a span', async () => {
        const stream = await client.models.generateContentStream({
          model: 'gemini-2.0-flash',
          contents: 'Hello, world!'
        })

        for await (const chunk of stream) {
          assert.ok(chunk)
        }

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'llm',
          name: 'google_genai.request',
          modelName: 'gemini-2.0-flash',
          modelProvider: 'google',
          inputMessages: [{ role: 'user', content: 'Hello, world!' }],
          outputMessages: [{ role: 'assistant', content: MOCK_STRING }],
          metadata: {
            temperature: null,
            top_p: null,
            top_k: null,
            candidate_count: null,
            max_output_tokens: null,
            stop_sequences: null,
            response_logprobs: null,
            logprobs: null,
            presence_penalty: null,
            frequency_penalty: null,
            seed: null,
            response_mime_type: null,
            safety_settings: null,
            automatic_function_calling: null
          },
          metrics: {
            input_tokens: MOCK_NUMBER,
            output_tokens: MOCK_NUMBER,
            total_tokens: MOCK_NUMBER,
          },
          tags: { ml_app: 'test', integration: 'google_genai' },
        })
      })
    })

    describe('models.embedContent', () => {
      it('creates a span', async () => {
        const result = await client.models.embedContent({
          model: 'text-embedding-004',
          contents: 'Hello, world!'
        })

        assert.ok(result)

        const { apmSpans, llmobsSpans } = await getEvents()
        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'embedding',
          name: 'google_genai.request',
          modelName: 'text-embedding-004',
          modelProvider: 'google',
          inputDocuments: [{ text: 'Hello, world!' }],
          outputValue: MOCK_STRING,
          tags: { ml_app: 'test', integration: 'google_genai' },
        })
      })
    })
  })
})
