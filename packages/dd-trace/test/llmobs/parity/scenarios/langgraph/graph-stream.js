'use strict'

const { finish } = require('../common')
const helpers = require('../langchain/helpers')

function buildGraph () {
  const { StateGraph, START, END, Annotation } = helpers.langgraphModule()
  const State = Annotation.Root({
    steps: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }),
  })
  return new StateGraph(State)
    .addNode('agent_a', () => ({ steps: ['a'] }))
    .addNode('agent_b', () => ({ steps: ['b'] }))
    .addEdge(START, 'agent_a')
    .addEdge('agent_a', 'agent_b')
    .addEdge('agent_b', END)
    .compile({ name: 'ParityGraph' })
}

async function main () {
  const tracer = helpers.loadLangChainTracer()
  const stream = await buildGraph().stream({ steps: [] })
  for await (const chunk of stream) void chunk
  await finish(tracer)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
