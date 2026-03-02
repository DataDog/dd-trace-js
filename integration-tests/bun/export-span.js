'use strict'

const tracer = require('dd-trace')

tracer.init({
  startupLogs: false,
  url: process.env.DD_TRACE_AGENT_URL,
  flushInterval: 10,
})

const span = tracer.startSpan('bun.smoke')
span.finish()

setTimeout(() => {
  // eslint-disable-next-line no-console
  console.log('ok')
  process.exit()
}, 300)
