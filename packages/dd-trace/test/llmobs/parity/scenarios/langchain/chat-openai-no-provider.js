'use strict'

const { finish } = require('../common')
const helpers = require('./helpers')

async function main () {
  const tracer = helpers.loadLangChainTracer({ providers: false })
  const model = helpers.chatOpenAI({ temperature: 0, maxTokens: 16 })
  await model.invoke([['user', 'Hello from the parity harness.']])
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
