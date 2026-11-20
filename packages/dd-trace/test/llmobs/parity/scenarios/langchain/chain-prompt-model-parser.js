'use strict'

const { finish } = require('../common')
const helpers = require('./helpers')

async function main () {
  const tracer = helpers.loadLangChainTracer()
  const { ChatPromptTemplate } = helpers.coreModule('@langchain/core/prompts')
  const { StringOutputParser } = helpers.coreModule('@langchain/core/output_parsers')
  const prompt = ChatPromptTemplate.fromMessages([
    ['system', 'You are a parity assistant.'],
    ['human', '{input}'],
  ])
  const chain = prompt.pipe(helpers.chatOpenAI({ temperature: 0, maxTokens: 16 })).pipe(new StringOutputParser())
  await chain.invoke({ input: 'Hello from the parity harness.' })
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
