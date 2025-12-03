import http from 'http'
import { GoogleGenAI } from '@google/genai'

const mockResponse = {
  candidates: [{
    content: {
      parts: [{ text: 'Hello!' }],
      role: 'model'
    },
    finishReason: 'STOP'
  }],
  usageMetadata: {
    promptTokenCount: 5,
    candidatesTokenCount: 2,
    totalTokenCount: 7
  }
}

// Create a mock server
const mockServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(mockResponse))
})

await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve))
const mockPort = mockServer.address().port

const client = new GoogleGenAI({
  apiKey: '<not-a-real-key>',
  httpOptions: { baseUrl: `http://127.0.0.1:${mockPort}` }
})

await client.models.generateContent({
  model: 'gemini-2.0-flash',
  contents: 'Hello, world!'
})

mockServer.close()
