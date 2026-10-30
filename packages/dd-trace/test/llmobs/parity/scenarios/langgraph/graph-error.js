'use strict'

const { finish } = require('../common')
const helpers = require('../langchain/helpers')

async function main () {
  const tracer = helpers.loadLangChainTracer()
  const { StateGraph, START, END, Annotation } = helpers.langgraphModule()
  const State = Annotation.Root({
    steps: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }),
  })
  const graph = new StateGraph(State)
    .addNode('agent_a', () => ({ steps: ['a'] }))
    .addNode('agent_fails', () => { throw new Error('parity node failure') })
    .addEdge(START, 'agent_a')
    .addEdge('agent_a', 'agent_fails')
    .addEdge('agent_fails', END)
    .compile({ name: 'ParityGraph' })
  try {
    await graph.invoke({ steps: [] })
  } catch {
    // expected
  }
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
