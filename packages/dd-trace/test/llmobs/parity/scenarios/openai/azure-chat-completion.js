'use strict'

const { finish, loadTracer, loadVersionedModule } = require('../common')

async function main () {
  const tracer = loadTracer('openai')
  const OpenAI = loadVersionedModule('openai')
  const client = new OpenAI.AzureOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    apiVersion: '2024-02-01',
    endpoint: `${process.env.PROVIDER_BASE_URL}/azure`,
  })
  await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Say parity' }],
    max_tokens: 8,
    temperature: 0,
  })
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
