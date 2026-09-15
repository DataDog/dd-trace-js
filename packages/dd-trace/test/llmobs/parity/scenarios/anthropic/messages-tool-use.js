'use strict'

const { finish, loadTracer, loadVersionedModule } = require('../common')

async function main () {
  const tracer = loadTracer('anthropic')
  const { Anthropic } = loadVersionedModule('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.PROVIDER_BASE_URL })
  await client.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
    tools: [{
      name: 'get_weather',
      description: 'Get current weather.',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    }],
    tool_choice: { type: 'tool', name: 'get_weather' },
  })
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
