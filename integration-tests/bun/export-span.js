'use strict'

const tracer = require('dd-trace')

const finish = require('./finish')

tracer.init({
  startupLogs: false,
  url: process.env.DD_TRACE_AGENT_URL,
  flushInterval: 10,
})

const span = tracer.startSpan('bun.smoke')
span.finish()

finish()
