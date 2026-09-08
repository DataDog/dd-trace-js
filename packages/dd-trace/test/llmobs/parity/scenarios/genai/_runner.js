'use strict'

const path = require('node:path')
const { finish, loadTracer } = require('../common')

const ROOT = path.resolve(__dirname, '../../../../../../../')
const sdkPackage = path.join(ROOT, 'versions/@google/genai')

async function run (scenario) {
  const tracer = loadTracer('google-genai')
  const { GoogleGenAI } = require(sdkPackage).get()
  const client = new GoogleGenAI({
    apiKey: 'test',
    httpOptions: { baseUrl: process.env.PROVIDER_BASE_URL },
  })
  const model = scenario === 'generate-content-model-path' ? 'models/gemini-2.5-flash' : 'gemini-2.5-flash'
  try {
    if (scenario === 'embed-content') {
      await client.models.embedContent({
        model: 'text-embedding-004',
        contents: 'Hello, world!',
        config: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: 8 },
      })
    } else if (scenario === 'generate-content-stream') {
      const stream = await client.models.generateContentStream({
        model,
        contents: 'Hello, world!',
        config: { temperature: 0.5, maxOutputTokens: 100, systemInstruction: 'You are a parity bot.' },
      })
      for await (const chunk of stream) void chunk
    } else {
      await client.models.generateContent({
        model,
        contents: scenario === 'generate-content-tools'
          ? [
              { role: 'user', parts: [{ text: 'Use the tool.' }] },
              {
                role: 'model',
                parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: { value: 'parity' } } }],
              },
              {
                role: 'user',
                parts: [{ functionResponse: { id: 'call-1', name: 'lookup', response: { value: 'ok' } } }],
              },
            ]
          : 'Hello, world!',
        config: scenario === 'generate-content-reasoning'
          ? { temperature: 0.5, maxOutputTokens: 100, systemInstruction: 'You are a parity bot.' }
          : scenario === 'generate-content-tools'
            ? {
                temperature: 0.5,
                maxOutputTokens: 100,
                systemInstruction: 'You are a parity bot.',
                tools: [{
                  functionDeclarations: [{
                    name: 'lookup',
                    description: 'Look up a value.',
                    parameters: { type: 'OBJECT', properties: { value: { type: 'STRING' } } },
                  }],
                }],
              }
            : { temperature: 0.5, maxOutputTokens: 100, systemInstruction: 'You are a parity bot.' },
      })
    }
  } catch (error) {
    void error
  } finally {
    await finish(tracer)
  }
}

module.exports = { run }
