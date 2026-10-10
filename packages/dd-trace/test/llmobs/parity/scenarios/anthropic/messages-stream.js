'use strict'

const { finish, loadTracer, loadVersionedModule } = require('../common')

async function main () {
  const tracer = loadTracer('anthropic')
  const { Anthropic } = loadVersionedModule('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.PROVIDER_BASE_URL })
  const stream = await client.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 16,
    stream: true,
    messages: [{ role: 'user', content: 'Stream a short parity response.' }],
  })
  for await (const chunk of stream) void chunk
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
