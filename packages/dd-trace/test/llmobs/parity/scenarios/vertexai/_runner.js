'use strict'

const path = require('node:path')
const { finish, loadTracer } = require('../common')

const ROOT = path.resolve(__dirname, '../../../../../../../')
const sdkPackage = path.join(ROOT, 'versions/@google-cloud/vertexai')

async function run (scenario) {
  const tracer = loadTracer('google-cloud-vertexai')
  const vertex = require(sdkPackage).get()
  const { GoogleAuth } = require(path.join(
    ROOT,
    'versions/@google-cloud/vertexai/node_modules/google-auth-library/build/src/auth/googleauth'
  ))
  const originalToken = GoogleAuth.prototype.getAccessToken
  const originalFetch = global.fetch
  const provider = new URL(process.env.PROVIDER_BASE_URL)
  GoogleAuth.prototype.getAccessToken = async () => ({ token: 'test' })
  global.fetch = (url, options) => {
    const target = new URL(url)
    target.protocol = provider.protocol
    target.host = provider.host
    return originalFetch(target, options)
  }
  try {
    const client = new vertex.VertexAI({ project: 'parity-project', location: 'us-central1', apiEndpoint: provider.host })
    const model = client.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: 'You are a parity bot.',
      generationConfig: { temperature: 1, maxOutputTokens: 50 },
      ...(scenario === 'generate-content-tools'
        ? {
            tools: [{
              functionDeclarations: [{
                name: 'add',
                description: 'Add two numbers.',
                parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
              }],
            }],
          }
        : {}),
    })
    if (scenario === 'generate-content-stream') {
      const result = await model.generateContentStream('Hello, how are you?')
      for await (const chunk of result.stream) void chunk
      await result.response
    } else if (scenario === 'chat-send-message') {
      const chat = model.startChat({
        history: [
          { role: 'user', parts: [{ text: 'Hello.' }] },
          { role: 'model', parts: [{ text: 'Hi.' }] },
        ],
      })
      await chat.sendMessage('Continue the parity conversation.')
    } else {
      await model.generateContent(scenario === 'generate-content-tools'
        ? {
            contents: [
              { role: 'user', parts: [{ text: 'What is 2 + 2?' }] },
              { role: 'model', parts: [{ functionCall: { name: 'add', args: { a: 2, b: 2 } } }] },
              { role: 'user', parts: [{ functionResponse: { name: 'add', response: { result: 4 } } }] },
            ],
          }
        : 'Hello, how are you?')
    }
  } catch (error) {
    void error
  } finally {
    GoogleAuth.prototype.getAccessToken = originalToken
    global.fetch = originalFetch
    await finish(tracer)
  }
}

module.exports = { run }
