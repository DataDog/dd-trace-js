'use strict'

const { finish, loadTracer, loadVersionedModule } = require('../common')

async function main () {
  const tracer = loadTracer('openai')
  const OpenAI = loadVersionedModule('openai')
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: `${process.env.PROVIDER_BASE_URL}/v1` })
  const stream = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Stream a short parity response.' }],
    temperature: 0,
    max_tokens: 16,
    stream: true,
  })
  for await (const chunk of stream) void chunk
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
