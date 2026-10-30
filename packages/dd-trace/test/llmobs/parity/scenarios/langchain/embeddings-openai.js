'use strict'

const { finish } = require('../common')
const helpers = require('./helpers')

async function main () {
  const tracer = helpers.loadLangChainTracer()
  const embeddings = helpers.openAIEmbeddings()
  await embeddings.embedQuery('Embed this parity text.')
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
