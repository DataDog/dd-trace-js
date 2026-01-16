'use strict'

const tracer = require('./packages/dd-trace').init()

// Subscribe to channels to debug
const dc = require('node:diagnostics_channel')

dc.subscribe('apm:langgraph:stream:start', msg => console.log('[DC] start published'))
dc.subscribe('apm:langgraph:stream:asyncEnd', msg => console.log('[DC] asyncEnd published'))
dc.subscribe('apm:langgraph:stream:error', msg => console.log('[DC] error published'))

console.log('Channel subscribers after tracer init:')
console.log('  start:', dc.hasSubscribers('apm:langgraph:stream:start'))
console.log('  asyncEnd:', dc.hasSubscribers('apm:langgraph:stream:asyncEnd'))

// Now load langgraph
const lg = require('./versions/@langchain/langgraph@>=1.0.15').get()
console.log('\nAfter LangGraph load')

// Create and run a stream
const { StateGraph, START, END } = lg

async function test () {
  const graph = new StateGraph({ channels: { data: { value: (x, y) => y, default: () => null } } })
  graph.addNode('test', async (s) => ({ data: 'done' }))
  graph.addEdge(START, 'test')
  graph.addEdge('test', END)
  const app = graph.compile()

  console.log('\nRunning stream...')
  const stream = await app.stream({ data: 'input' })
  for await (const chunk of stream) {
    console.log('chunk:', JSON.stringify(chunk))
  }
  console.log('Stream complete')

  // Wait for spans
  await new Promise(r => setTimeout(r, 2000))
}

test().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
