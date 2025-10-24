'use strict'

/* eslint-disable no-console */
const tracer = require('../packages/dd-trace')
const { isTrue, isFalse } = require('../packages/dd-trace/src/util')
const log = require('../packages/dd-trace/src/log')
const { getEnvironmentVariable } = require('../packages/dd-trace/src/config-helper')

const PACKAGE_MANAGERS = ['npm', 'yarn', 'pnpm']
const DEFAULT_FLUSH_INTERVAL = 5000
const JEST_FLUSH_INTERVAL = 0
const EXPORTER_MAP = {
  jest: 'jest_worker',
  cucumber: 'cucumber_worker',
  mocha: 'mocha_worker',
  playwright: 'playwright_worker',
  vitest: 'vitest_worker'
}

function isPackageManager () {
  return PACKAGE_MANAGERS.some(packageManager =>
    process.argv[1]?.includes(`bin/${packageManager}`)
  )
}

function detectTestWorkerType () {
  if (getEnvironmentVariable('JEST_WORKER_ID')) return 'jest'
  if (getEnvironmentVariable('CUCUMBER_WORKER_ID')) return 'cucumber'
  if (getEnvironmentVariable('MOCHA_WORKER_ID')) return 'mocha'
  if (getEnvironmentVariable('DD_PLAYWRIGHT_WORKER')) return 'playwright'
  if (getEnvironmentVariable('TINYPOOL_WORKER_ID')) return 'vitest'
  return null
}

const testWorkerType = detectTestWorkerType()
const isTestWorker = testWorkerType !== null
const isJestWorker = testWorkerType === 'jest'

const baseOptions = {
  startupLogs: false,
  isCiVisibility: true,
  flushInterval: isJestWorker ? JEST_FLUSH_INTERVAL : DEFAULT_FLUSH_INTERVAL
}

let shouldInit = !isFalse(getEnvironmentVariable('DD_CIVISIBILITY_ENABLED'))
const isAgentlessEnabled = isTrue(getEnvironmentVariable('DD_CIVISIBILITY_AGENTLESS_ENABLED'))

if (!isTestWorker && isPackageManager()) {
  log.debug('dd-trace is not initialized in a package manager.')
  shouldInit = false
}

if (isTestWorker) {
  baseOptions.telemetry = { enabled: false }
  baseOptions.experimental = {
    exporter: EXPORTER_MAP[testWorkerType]
  }
} else {
  if (isAgentlessEnabled) {
    if (getEnvironmentVariable('DD_API_KEY')) {
      baseOptions.experimental = {
        exporter: 'datadog'
      }
    } else {
      console.error(
        'DD_CIVISIBILITY_AGENTLESS_ENABLED is set, but neither ' +
        'DD_API_KEY nor DATADOG_API_KEY are set in your environment, so ' +
        'dd-trace will not be initialized.'
      )
      shouldInit = false
    }
  } else {
    baseOptions.experimental = {
      exporter: 'agent_proxy'
    }
  }
}

if (shouldInit) {
  tracer.init(baseOptions)
  tracer.use('fs', false)
  tracer.use('child_process', false)
}

module.exports = tracer
