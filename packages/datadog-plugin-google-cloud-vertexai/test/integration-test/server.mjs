import 'dd-trace/init.js'

import { VertexAI } from '@google-cloud/vertexai'
import { GoogleAuth } from 'google-auth-library/build/src/auth/googleauth.js'

import sinon from 'sinon'
const authStub = sinon.stub(GoogleAuth.prototype, 'getAccessToken').resolves({})

const originalFetch = global.fetch
global.fetch = async (url, options) => {
  const responseBody = JSON.stringify({
    candidates: [{
      content: {
        role: 'model',
        parts: [{ text: 'Hello! How can I assist you today?' }]
      },
      finishReason: 'STOP',
      avgLogprobs: -0.0016951755387708545
    }],
    usageMetadata: {
      promptTokenCount: 35,
      candidatesTokenCount: 2,
      totalTokenCount: 37,
      promptTokensDetails: [{
        modality: 'TEXT', tokenCount: 35
      }],
      candidatesTokensDetails: [{
        modality: 'TEXT',
        tokenCount: 2
      }]
    },
    modelVersion: 'gemini-1.5-flash-002',
    createTime: '2025-02-25T18:45:57.459163Z',
    responseId: '5Q--Z5uDHLWX2PgP1eLSwAk'
  })
  return new Response(responseBody, {
    status: 200,
    headers: {
      'Content-Type': 'application/json'
    }
  })
}

try {
  const client = new VertexAI({
    project: 'datadog-sandbox',
    location: 'us-central1'
  })

  const model = client.getGenerativeModel({
    model: 'gemini-1.5-flash-002',
    generationConfig: {
      maxOutputTokens: 100,
      stopSequences: ['\n']
    }
  })

  await model.generateContent('Hi!')
} finally {
  global.fetch = originalFetch
  authStub.restore()
}
