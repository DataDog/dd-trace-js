'use strict'

const { setup, simpleAgent } = require('./common')

async function main () {
  const { agents, finish } = setup()
  const result = await agents.run(simpleAgent(), 'What is the capital of France?', { stream: true })
  for await (const event of result) void event
  await finish()
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
