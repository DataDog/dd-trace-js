'use strict'

const { finish, loadTracer, loadVersionedModule } = require('../common')

async function main () {
  const tracer = loadTracer('openai')
  const OpenAI = loadVersionedModule('openai')
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: `${process.env.PROVIDER_BASE_URL}/v1` })
  const stream = await client.responses.create({
    model: 'gpt-4o-mini',
    input: 'Say parity',
    stream: true,
  })
  for await (const event of stream) void event
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
