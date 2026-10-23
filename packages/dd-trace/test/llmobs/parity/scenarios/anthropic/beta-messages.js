'use strict'

const { finish, loadTracer, loadVersionedModule } = require('../common')

async function main () {
  const tracer = loadTracer('anthropic')
  const { Anthropic } = loadVersionedModule('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.PROVIDER_BASE_URL })
  await client.beta.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Hello from the beta parity harness.' }],
  })
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
