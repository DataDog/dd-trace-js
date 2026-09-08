'use strict'

const { finish } = require('../common')
const helpers = require('./helpers')

async function main () {
  const tracer = helpers.loadLangChainTracer()
  const { MemoryVectorStore } = helpers.classicModule('@langchain/classic/vectorstores/memory')
  const { Document } = helpers.coreModule('@langchain/core/documents')
  const store = new MemoryVectorStore(helpers.openAIEmbeddings())
  await store.addDocuments([
    new Document({ pageContent: 'Parity document one.', id: 'doc-1', metadata: { source: 'one.txt' } }),
    new Document({ pageContent: 'Parity document two.', id: 'doc-2', metadata: { source: 'two.txt' } }),
  ])
  await store.similaritySearch('parity', 2)
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
