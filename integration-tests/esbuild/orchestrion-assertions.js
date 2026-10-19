'use strict'

require('../../').init() // dd-trace

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')

const MODULE_NAME = '@langchain/langgraph'
const activations = []
dc.subscribe('dd-trace:instrumentation:load', ({ name }) => {
  if (name === MODULE_NAME) activations.push(name)
})

let streamStarts = 0
dc.subscribe(`tracing:orchestrion:${MODULE_NAME}:Pregel_stream:start`, () => {
  streamStarts++
})

/** @param {typeof import('@langchain/langgraph')} langgraph */
module.exports = function testGraph ({ StateGraph, Annotation, START, END }) {
  const State = Annotation.Root({ step: Annotation({ default: () => 0, reducer: (_, next) => next }) })
  const graph = new StateGraph(State)
    .addNode('one', () => ({ step: 1 }))
    .addEdge(START, 'one')
    .addEdge('one', END)
    .compile()

  graph.invoke({}).then((result) => {
    assert.deepEqual(result, { step: 1 })
    assert.ok(activations.length > 0, `${MODULE_NAME} was not activated. using node@${process.version}`)
    assert.equal(streamStarts, 1, `Pregel.stream was not rewritten. using node@${process.version}`)
    process.exit(0)
  }).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error)
    process.exit(1)
  })
}
