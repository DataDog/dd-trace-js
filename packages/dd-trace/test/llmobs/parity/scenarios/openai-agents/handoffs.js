'use strict'

const { researchWorkflow, setup } = require('./common')

async function main () {
  const { agents, finish } = setup()
  await agents.run(researchWorkflow(), 'What is a brief summary of what happened yesterday in the soccer world??')
  await finish()
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
