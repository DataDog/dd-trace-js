const tracer = require('../packages/dd-trace')

tracer.init({
  startupLogs: false,
  ci: true
})

tracer.use('fs', false)

module.exports = tracer
