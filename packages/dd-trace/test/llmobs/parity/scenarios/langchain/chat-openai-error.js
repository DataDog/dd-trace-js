'use strict'

const { finish } = require('../common')
const helpers = require('./helpers')

async function main () {
  const tracer = helpers.loadLangChainTracer()
  const model = helpers.chatOpenAI({ temperature: 0, maxRetries: 0 })
  try {
    await model.invoke([['user', 'This request fails.']])
  } catch {
    // expected: the stub returns a 400
  }
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
