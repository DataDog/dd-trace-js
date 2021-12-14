const tracer = require('../packages/dd-trace')

tracer.init({
  startupLogs: false
})

tracer.use('fs', false)

module.exports = tracer
