process.env.DD_TRACE_DISABLED_PLUGINS = 'fs'

const tracer = require('../../packages/dd-trace')

tracer.init({
  startupLogs: false,
  flushInterval: 400000
})

module.exports = tracer
