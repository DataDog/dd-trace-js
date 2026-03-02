'use strict'

const tracer = require('dd-trace')

tracer.init({
  startupLogs: true,
  url: process.env.DD_TRACE_AGENT_URL || 'http://127.0.0.1:1',
  flushInterval: 10,
})

const span = tracer.startSpan('bun.unavailable-agent')
span.finish()

setTimeout(() => {
  // eslint-disable-next-line no-console
  console.log('ok')
  process.exit(0)
}, 300)
