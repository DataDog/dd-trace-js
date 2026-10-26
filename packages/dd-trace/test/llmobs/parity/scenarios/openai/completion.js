'use strict'

const { finish, loadTracer, loadVersionedModule } = require('../common')

async function main () {
  const tracer = loadTracer('openai')
  const OpenAI = loadVersionedModule('openai')
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: `${process.env.PROVIDER_BASE_URL}/v1` })
  await client.completions.create({
    model: 'gpt-3.5-turbo-instruct',
    prompt: 'Say parity',
    max_tokens: 8,
    temperature: 0,
  })
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
