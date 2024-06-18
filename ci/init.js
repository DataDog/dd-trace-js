/* eslint-disable no-console */
const tracer = require('../packages/dd-trace')
const { isTrue } = require('../packages/dd-trace/src/util')
const { isMainThread, parentPort } = require('node:worker_threads')

const isJestWorker = !!process.env.JEST_WORKER_ID
const isCucumberWorker = !!process.env.CUCUMBER_WORKER_ID
const isMochaWorker = !!process.env.MOCHA_WORKER_ID
// eslint-disable-next-line
// https://github.com/vitest-dev/vitest/blob/f969fb0f9f0247a7daa2afee8f70de25ea5e123f/packages/vitest/src/node/pool.ts#L110-L111
const isVitestWorker = !isMainThread && process.env.VITEST === 'true' && process.env.TEST === 'true'

const options = {
  startupLogs: false,
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
    console.error('DD_CIVISIBILITY_AGENTLESS_ENABLED is set, but neither ' +
      'DD_API_KEY nor DATADOG_API_KEY are set in your environment, so ' +
      'dd-trace will not be initialized.')
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

if (isCucumberWorker) {
  options.experimental = {
    exporter: 'cucumber_worker'
  }
}

if (isMochaWorker) {
  options.experimental = {
    exporter: 'mocha_worker'
  }
}

if (isVitestWorker) {
  // if (parentPort?.postMessage) {
  //   parentPort.postMessage({ type: 'ci:vitest:worker:ready' })
  // }
}

if (shouldInit) {
  tracer.init(options)
  tracer.use('fs', false)
  tracer.use('child_process', false)
}

module.exports = tracer
