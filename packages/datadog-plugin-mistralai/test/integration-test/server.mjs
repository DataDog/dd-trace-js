import { Mistral } from '@mistralai/mistralai'

const client = new Mistral({ serverURL: 'http://127.0.0.1:9126/vcr/mistral', retryConfig: { strategy: 'none' } })

await client.chat.complete({
  model: 'mistral-large-latest',
  messages: [{ role: 'user', content: 'Why is the sky blue?' }],
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 100,
  randomSeed: 42,
  presencePenalty: 0,
  frequencyPenalty: 0,
})
