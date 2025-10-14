import { Anthropic } from '@anthropic-ai/sdk'

const client = new Anthropic({ baseURL: 'http://127.0.0.1:9126/vcr/anthropic' })

await client.messages.create({
  model: 'claude-3-7-sonnet-20250219',
  messages: [{ role: 'user', content: 'Hello, world!' }],
  max_tokens: 100,
  temperature: 0.5
})
