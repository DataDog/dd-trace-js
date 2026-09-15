'use strict'

const { finish, loadTracer, loadVersionedModule } = require('../common')

async function main () {
  const tracer = loadTracer('openai')
  const OpenAI = loadVersionedModule('openai')
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: `${process.env.PROVIDER_BASE_URL}/v1`,
    maxRetries: 0,
  })
  try {
    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Say parity' }],
      max_tokens: 8,
    })
  } catch {}
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
