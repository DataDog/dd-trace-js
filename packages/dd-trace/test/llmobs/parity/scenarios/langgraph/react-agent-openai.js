'use strict'

const { finish } = require('../common')
const helpers = require('../langchain/helpers')

async function main () {
  const tracer = helpers.loadLangChainTracer()
  const { createReactAgent } = helpers.langgraphModule('@langchain/langgraph/prebuilt')
  const { tool } = helpers.coreModule('@langchain/core/tools')
  const { z } = helpers.zod()
  const add = tool(({ a, b }) => String(a + b), {
    name: 'add',
    description: 'Adds two numbers together',
    schema: z.object({ a: z.number(), b: z.number() }),
  })
  const agent = createReactAgent({
    llm: helpers.chatOpenAI({ temperature: 0.5 }),
    tools: [add],
    name: 'parity_agent',
    prompt: 'You are a helpful assistant.',
  })
  await agent.invoke({ messages: [{ role: 'user', content: 'What is 2 + 2?' }] })
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
