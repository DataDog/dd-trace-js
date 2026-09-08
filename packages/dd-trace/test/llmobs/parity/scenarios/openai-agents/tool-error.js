'use strict'

const { additionAgentWithToolErrors, setup } = require('./common')

async function main () {
  const { agents, finish } = setup()
  await agents.run(additionAgentWithToolErrors(), 'What is the sum of 1 and 2?')
  await finish()
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
