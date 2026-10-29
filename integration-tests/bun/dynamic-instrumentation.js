'use strict'

const tracer = require('dd-trace')

tracer.init({
  url: process.env.DD_TRACE_AGENT_URL,
})

// Leave time for Remote Config to enable Live Debugger/Dynamic Instrumentation, and for the tracer to poll again
setTimeout(() => {
  // eslint-disable-next-line no-console
  console.log('ok')
  process.exit(0)
}, 1000)
