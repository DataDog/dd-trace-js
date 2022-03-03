const tracer = require('../packages/dd-trace')
const { ORIGIN_KEY } = require('../packages/dd-trace/src/constants')

const options = {
  startupLogs: false,
  tags: {
    [ORIGIN_KEY]: 'ciapp-test'
  }
}

if (process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED && (process.env.DATADOG_API_KEY || process.env.DD_API_KEY)) {
  options.experimental = {
    exporter: 'ci'
  }
}

tracer.init(options)

tracer.use('fs', false)

module.exports = tracer
