// TODO: provide a way to do this with the init function
process.env.DD_TRACE_DISABLED_PLUGINS = 'fs'

const tracer = require('../packages/dd-trace')

tracer.init({
  startupLogs: false
})

module.exports = tracer
