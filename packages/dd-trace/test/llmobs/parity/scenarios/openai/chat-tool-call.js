'use strict'

const { finish, loadTracer, loadVersionedModule } = require('../common')

async function main () {
  const tracer = loadTracer('openai')
  const OpenAI = loadVersionedModule('openai')
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: `${process.env.PROVIDER_BASE_URL}/v1` })
  await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
    temperature: 0,
    max_tokens: 16,
  })
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
