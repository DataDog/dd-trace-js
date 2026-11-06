'use strict'

const { finish } = require('../common')
const helpers = require('./helpers')

async function main () {
  const tracer = helpers.loadLangChainTracer()
  const model = helpers.chatOpenAI({ temperature: 0, maxTokens: 16 })
  const stream = await model.stream([['user', 'Stream a short parity response.']])
  for await (const chunk of stream) void chunk
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
