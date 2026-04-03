import { GoogleGenAI } from '@google/genai'

const client = new GoogleGenAI({
  apiKey: process.env.GOOGLE_API_KEY,
  httpOptions: { baseUrl: 'http://127.0.0.1:9126/vcr/genai' },
})

await client.models.generateContent({
  model: 'gemini-2.0-flash',
  contents: 'Hello, world!',
})
