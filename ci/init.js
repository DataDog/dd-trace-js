'use strict'

/* eslint-disable no-console */
const tracer = require('../packages/dd-trace')
const { isTrue, isFalse } = require('../packages/dd-trace/src/util')
const log = require('../packages/dd-trace/src/log')
const { getEnvironmentVariable } = require('../packages/dd-trace/src/config-helper')

const isJestWorker = !!getEnvironmentVariable('JEST_WORKER_ID')
const isCucumberWorker = !!getEnvironmentVariable('CUCUMBER_WORKER_ID')
const isMochaWorker = !!getEnvironmentVariable('MOCHA_WORKER_ID')

// We can't use VITEST_WORKER_ID because it's set _after_ the worker is initialized
const isVitestWorker = !!getEnvironmentVariable('TINYPOOL_WORKER_ID')
const isPlaywrightWorker = !!getEnvironmentVariable('DD_PLAYWRIGHT_WORKER')

const isTestWorker = isJestWorker || isCucumberWorker || isMochaWorker || isVitestWorker || isPlaywrightWorker

const packageManagers = [
  'npm',
  'yarn',
  'pnpm'
]

const isPackageManager = () => {
  return packageManagers.some(packageManager => process.argv[1]?.includes(`bin/${packageManager}`))
}

const options = {
  startupLogs: false,
  isCiVisibility: true,
  flushInterval: isJestWorker ? 0 : 5000
}

let shouldInit = !isFalse(getEnvironmentVariable('DD_CIVISIBILITY_ENABLED'))
const isAgentlessEnabled = isTrue(getEnvironmentVariable('DD_CIVISIBILITY_AGENTLESS_ENABLED'))

if (!isTestWorker && isPackageManager()) {
  log.debug('dd-trace is not initialized in a package manager.')
  shouldInit = false
}

if (isTestWorker) {
  options.telemetry = {
    enabled: false
  }
  if (isJestWorker) {
    options.experimental = {
      exporter: 'jest_worker'
    }
  } else if (isCucumberWorker) {
    options.experimental = {
      exporter: 'cucumber_worker'
    }
  } else if (isMochaWorker) {
    options.experimental = {
      exporter: 'mocha_worker'
    }
  } else if (isPlaywrightWorker) {
    options.experimental = {
      exporter: 'playwright_worker'
    }
  } else if (isVitestWorker) {
    options.experimental = {
      exporter: 'vitest_worker'
    }
  }
} else {
  // If a test worker is running, it will not communicate with the intake
  // or the agent, so this logic only applies to non-test workers.
  if (isAgentlessEnabled) {
    if (getEnvironmentVariable('DD_API_KEY')) {
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
}

if (shouldInit) {
  tracer.init(options)
  tracer.use('fs', false)
  tracer.use('child_process', false)
}

module.exports = tracer
