import { GoogleGenAI } from '@google/genai'

const client = new GoogleGenAI({
  apiKey: process.env.GOOGLE_API_KEY,
  // Match the API version used by the VCR cassettes.
  httpOptions: { baseUrl: 'http://127.0.0.1:9126/vcr/genai', apiVersion: 'v1beta' },
})

await client.models.generateContent({
  model: 'gemini-2.0-flash',
  contents: 'Hello, world!',
})
