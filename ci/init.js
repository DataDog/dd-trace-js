'use strict'

/* eslint-disable no-console */
const { isMainThread } = require('node:worker_threads')

const { getEnvironmentVariable, getValueFromEnvSources } = require('../packages/dd-trace/src/config/helper')
const log = require('../packages/dd-trace/src/log')
const { isTrue } = require('../packages/dd-trace/src/util')

const PACKAGE_MANAGERS = ['npm', 'yarn', 'pnpm']
const DEFAULT_FLUSH_INTERVAL = 5000
const JEST_FLUSH_INTERVAL = 0
const VITEST_NO_WORKER_INIT_ACTIVE_ENV = 'DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE'
const EXPORTER_MAP = {
  jest: 'jest_worker',
  cucumber: 'cucumber_worker',
  mocha: 'mocha_worker',
  playwright: 'playwright_worker',
  vitest: 'vitest_worker',
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
  if (getValueFromEnvSources('DD_PLAYWRIGHT_WORKER')) return 'playwright'
  if (getEnvironmentVariable('TINYPOOL_WORKER_ID')) return 'vitest'
  if (getValueFromEnvSources('DD_VITEST_WORKER')) return 'vitest'
  return null
}

const testWorkerType = detectTestWorkerType()
const isTestWorker = testWorkerType !== null
const isJestWorker = testWorkerType === 'jest'

const baseOptions = {
  startupLogs: false,
  isCiVisibility: true,
  flushInterval: isJestWorker ? JEST_FLUSH_INTERVAL : DEFAULT_FLUSH_INTERVAL,
}

// skipDefault: CI visibility stays on unless DD_CIVISIBILITY_ENABLED is explicitly false; the
// registered default (false) would otherwise turn it off whenever the variable is unset.
let shouldInit = getValueFromEnvSources('DD_CIVISIBILITY_ENABLED', true) !== false
const isAgentlessEnabled = getValueFromEnvSources('DD_CIVISIBILITY_AGENTLESS_ENABLED')

if (!isTestWorker && isPackageManager()) {
  log.debug('dd-trace is not initialized in a package manager.')
  shouldInit = false
}

if (isTestWorker) {
  baseOptions.telemetry = { enabled: false }
  baseOptions.experimental = {
    exporter: EXPORTER_MAP[testWorkerType],
  }
} else {
  if (isAgentlessEnabled) {
    if (getValueFromEnvSources('DD_API_KEY')) {
      baseOptions.experimental = {
        exporter: 'datadog',
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
      exporter: 'agent_proxy',
    }
  }
}

const skipVitestWorkerInit = shouldSkipVitestWorkerInit()

const tracer = skipVitestWorkerInit
  ? {
      init () {},
      use () {},
    }
  : require('../packages/dd-trace')

if (shouldInit && !skipVitestWorkerInit) {
  tracer.init(baseOptions)
  tracer.use('fs', false)
  tracer.use('child_process', false)
}

module.exports = tracer

function shouldSkipVitestWorkerInit () {
  return shouldInit &&
    isMainThread &&
    getValueFromEnvSources('DD_VITEST_WORKER') &&
    isVitestNoWorkerInitActive()
}

function isVitestNoWorkerInitActive () {
  // eslint-disable-next-line eslint-rules/eslint-process-env
  return isTrue(process.env[VITEST_NO_WORKER_INIT_ACTIVE_ENV])
}
