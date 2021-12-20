const tracer = require('../../packages/dd-trace')

tracer.init({
  startupLogs: false,
  flushInterval: 400000,
  ci: true
})

tracer.use('fs', false)

module.exports = tracer
