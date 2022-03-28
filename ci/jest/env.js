const tracer = require('../../packages/dd-trace')
const { ORIGIN_KEY } = require('../../packages/dd-trace/src/constants')

const options = {
  startupLogs: false,
  tags: {
    [ORIGIN_KEY]: 'ciapp-test'
  }
}

if (process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED && (process.env.DATADOG_API_KEY || process.env.DD_API_KEY)) {
  tracer.init({
    ...options,
    experimental: {
      exporter: 'datadog'
    }
  })
} else {
  tracer.init({
    ...options,
    flushInterval: 400000
  })
}

tracer.use('fs', false)

module.exports = tracer
