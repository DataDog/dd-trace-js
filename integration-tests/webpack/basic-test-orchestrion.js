#!/usr/bin/env node
'use strict'

require('../../').init() // dd-trace

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')

const MODULE_NAME = '@langchain/langgraph'

// Published once the Orchestrion rewrite of `dist/pregel/index.cjs` is applied, which activates the plugin.
const activations = []
dc.subscribe('dd-trace:instrumentation:load', ({ name }) => {
  if (name === MODULE_NAME) activations.push(name)
})

// Published by the rewritten `Pregel.stream` (`graph.invoke()` calls `this.stream()` internally).
let streamStarts = 0
dc.subscribe(`tracing:orchestrion:${MODULE_NAME}:Pregel_stream:start`, () => {
  streamStarts++
})

const { StateGraph, Annotation, START, END } = require('@langchain/langgraph')

const State = Annotation.Root({ step: Annotation({ default: () => 0, reducer: (_, next) => next }) })
const graph = new StateGraph(State)
  .addNode('one', () => ({ step: 1 }))
  .addEdge(START, 'one')
  .addEdge('one', END)
  .compile()

graph.invoke({}).then((result) => {
  assert.deepEqual(result, { step: 1 })
  assert.ok(
    activations.length > 0,
    `${MODULE_NAME} was not activated by the Orchestrion rewriter. using node@${process.version}`
  )
  assert.equal(
    streamStarts,
    1,
    `Pregel.stream was not rewritten by Orchestrion. using node@${process.version}`
  )
  process.exit(0)
}).catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exit(1)
})
