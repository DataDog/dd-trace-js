/* eslint-disable no-console */

const tracer = require('../../packages/dd-trace')
const { ORIGIN_KEY } = require('../../packages/dd-trace/src/constants')
const { isTrue } = require('../../packages/dd-trace/src/util')

const options = {
  startupLogs: false,
  tags: {
    [ORIGIN_KEY]: 'ciapp-test'
  }
}

const isAgentlessEnabled = isTrue(process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED)

if (isAgentlessEnabled) {
  if (process.env.DATADOG_API_KEY || process.env.DD_API_KEY) {
    tracer.init({
      ...options,
      experimental: {
        exporter: 'datadog'
      }
    })
  } else {
    console.error(`DD_CIVISIBILITY_AGENTLESS_ENABLED is set, \
but neither DD_API_KEY nor DATADOG_API_KEY are set in your environment, \
so dd-trace will not be initialized.`)
  }
} else {
  tracer.init({
    ...options,
    flushInterval: 400000
  })
}

tracer.use('fs', false)

module.exports = tracer
