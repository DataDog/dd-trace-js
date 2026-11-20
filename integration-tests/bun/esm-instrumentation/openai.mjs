import OpenAI from 'openai'

import finish from '../finish.js'

const completion = {
  id: 'chatcmpl-bun',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from Bun' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
}

const server = globalThis.Bun.serve({ port: 0, fetch: () => Response.json(completion) })

const client = new OpenAI({ apiKey: 'test', baseURL: `http://127.0.0.1:${server.port}/v1` })

await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello' }],
})

server.stop()
finish()
