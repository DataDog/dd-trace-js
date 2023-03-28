/* eslint-disable no-console */

const path = require('path')
const tracer = require('../packages/dd-trace')
const { ORIGIN_KEY } = require('../packages/dd-trace/src/constants')
const { mochaHook } = require('../packages/datadog-instrumentations/src/mocha')
const { pickleHook, testCaseHook } = require('../packages/datadog-instrumentations/src/cucumber')

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

const isAgentlessEnabled = process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED &&
  process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED !== 'false' &&
  process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED !== '0'

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

// TODO: remove this in a later major version since we now recommend using
// `NODE_OPTIONS='-r dd-trace/ci/init'`.
try {
  for (const filename in require.cache) {
    const cache = require.cache[filename]
    const id = filename.split(path.sep).join('/')

    if (id.includes('/node_modules/mocha/lib/runner.js')) {
      cache.exports = mochaHook(cache.exports)
    } else if (id.includes('/node_modules/@cucumber/cucumber/lib/runtime/pickle_runner.js')) {
      cache.exports = pickleHook(cache.exports)
    } else if (id.includes('/node_modules/@cucumber/cucumber/lib/runtime/test_case_runner.js')) {
      cache.exports = testCaseHook(cache.exports)
    }
  }
} catch (e) {
  // ignore error and let the tracer initialize anyway
}

if (isJestWorker) {
  options.experimental = {
    exporter: 'jest_worker'
  }
}

if (shouldInit) {
  tracer.init(options)
  tracer.use('fs', false)
}

module.exports = tracer
