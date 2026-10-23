'use strict'

const { setup, simpleAgent } = require('./common')

async function main () {
  const { agents, finish } = setup()
  await agents.run(simpleAgent(), 'What is the capital of France?')
  await finish()
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
