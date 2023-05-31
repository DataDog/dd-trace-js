/* eslint-disable no-console */
const tracer = require('../packages/dd-trace')
const { ORIGIN_KEY } = require('../packages/dd-trace/src/constants')
const { isTrue } = require('../packages/dd-trace/src/util')
const { channel } = require('../packages/diagnostics_channel')

const isJestWorker = !!process.env.JEST_WORKER_ID

const options = {
  startupLogs: false,
  tags: {
    [ORIGIN_KEY]: 'ciapp-test'
  },
  isCiVisibility: true,
  flushInterval: isJestWorker ? 0 : 5000
}

let shouldInit = true

const isAgentlessEnabled = isTrue(process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED)

if (isAgentlessEnabled) {
  if (process.env.DATADOG_API_KEY || process.env.DD_API_KEY) {
    options.experimental = {
      exporter: 'datadog'
    }
  } else {
    console.error(`DD_CIVISIBILITY_AGENTLESS_ENABLED is set, \
but neither DD_API_KEY nor DATADOG_API_KEY are set in your environment, \
so dd-trace will not be initialized.`)
    shouldInit = false
  }
} else {
  options.experimental = {
    exporter: 'agent_proxy'
  }
}

if (isJestWorker) {
  options.experimental = {
    exporter: 'jest_worker'
  }
}

if (shouldInit) {
  tracer.init(options)
  tracer.use('fs', false)
  if (isTrue(process.env.DD_CIVISIBILITY_MANUAL_API_ENABLED)) {
    // To fake that we're loading a "manual" library, which triggers the instantiation of ManualPlugin
    const instrumentationLoad = channel('dd-trace:instrumentation:load')
    instrumentationLoad.publish({ name: 'manual' })
  }
}

module.exports = tracer
