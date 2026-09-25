'use strict'

const { finish } = require('../common')
const helpers = require('./helpers')

async function main () {
  const tracer = helpers.loadLangChainTracer()
  const { tool } = helpers.coreModule('@langchain/core/tools')
  const { z } = helpers.zod()
  const add = tool(({ a, b }) => String(a + b), {
    name: 'add',
    description: 'Adds two numbers together',
    schema: z.object({ a: z.number(), b: z.number() }),
  })
  await add.invoke({ a: 2, b: 2 })
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
