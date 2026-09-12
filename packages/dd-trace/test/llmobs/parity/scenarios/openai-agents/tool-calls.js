'use strict'

const { additionAgent, setup } = require('./common')

async function main () {
  const { agents, finish } = setup()
  await agents.run(additionAgent(), 'What is the sum of 1 and 2?')
  await finish()
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
