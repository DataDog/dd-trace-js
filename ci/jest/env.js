const tracer = require('../../packages/dd-trace')

tracer.init({
  startupLogs: false,
  flushInterval: 400000
})

tracer.use('fs', false)

module.exports = tracer
