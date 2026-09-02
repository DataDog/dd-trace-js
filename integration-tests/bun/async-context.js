'use strict'

const tracer = require('dd-trace')

const finish = require('./finish')

tracer.init({
  startupLogs: false,
  url: process.env.DD_TRACE_AGENT_URL,
  flushInterval: 10,
})

async function run () {
  await tracer.trace('bun.parent', async () => {
    await Promise.resolve()
    tracer.trace('bun.promise.child', () => {})

    await new Promise(resolve => setTimeout(resolve, 0))
    tracer.trace('bun.timer.child', () => {})
  })

  finish()
}

run().catch(error => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exit(1)
})
