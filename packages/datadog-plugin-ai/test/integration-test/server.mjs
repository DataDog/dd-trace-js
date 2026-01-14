import assert from 'node:assert'
import aiLib from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

const openai = createOpenAI({
  baseURL: 'http://127.0.0.1:9126/vcr/openai',
  apiKey: '<not-a-real-key>'
})

const result = await aiLib.generateText({
  model: openai('gpt-4o-mini'),
  system: 'You are a helpful assistant',
  prompt: 'Hello, OpenAI!',
  maxTokens: 100,
  temperature: 0.5
})

assert.ok(result.text, 'Expected result to be truthy')
