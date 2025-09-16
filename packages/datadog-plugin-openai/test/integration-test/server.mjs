import OpenAI from 'openai'

// load in openai agents to test iitm functionality
import { Agent, run } from '@openai/agents' // eslint-disable-line no-unused-vars

const params = {
  model: 'gpt-3.5-turbo-instruct',
  prompt: 'Hello, OpenAI!',
  max_tokens: 100,
  temperature: 0.5,
  n: 1,
  stream: false,
}

if (OpenAI.OpenAIApi) {
  const openaiApp = new OpenAI.OpenAIApi(new OpenAI.Configuration({
    apiKey: 'sk-DATADOG-ACCEPTANCE-TESTS',
    basePath: 'http://127.0.0.1:9126/vcr/openai'
  }))

  await openaiApp.createCompletion(params)
} else {
  const client = new OpenAI({
    apiKey: 'sk-DATADOG-ACCEPTANCE-TESTS',
    baseURL: 'http://127.0.0.1:9126/vcr/openai'
  })

  await client.completions.create(params)
}
