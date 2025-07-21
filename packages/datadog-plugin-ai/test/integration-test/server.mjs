import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import assert from 'node:assert'

const openai = createOpenAI({
  baseURL: 'http://127.0.0.1:10126/vcr/openai',
  apiKey: '<not-a-real-key>'
})

const result = await generateText({
  model: openai('gpt-3.5-turbo'),
  system: 'You are a helpful assistant',
  prompt: 'Hello, OpenAI!',
  maxTokens: 100,
  temperature: 0.5
})

assert.ok(result.text, 'Expected result to be truthy')
