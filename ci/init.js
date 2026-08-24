'use strict'

/* eslint-disable no-console */
/* eslint-disable eslint-rules/eslint-process-env */
const PACKAGE_MANAGERS = ['npm', 'yarn', 'pnpm']
const DEFAULT_FLUSH_INTERVAL = 5000
const JEST_FLUSH_INTERVAL = 0
const JEST_WORKER_INITIALIZE_MESSAGE = 0
const JEST_AUXILIARY_WORKER_PATHS = [
  '/@jest/reporters/build/CoverageWorker.js',
  '/jest-haste-map/build/worker.js',
]
const VITEST_NO_WORKER_INIT_ACTIVE_ENV = 'DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE'
const VALIDATION_MODE_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_MODE'
const VALIDATION_MANIFEST_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_MANIFEST_FILE'
const VALIDATION_OUTPUT_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_DIR'

function isPackageManager () {
  return PACKAGE_MANAGERS.some(packageManager =>
    process.argv[1]?.includes(`bin/${packageManager}`)
  )
}

if (process.env.JEST_WORKER_ID && process.send) {
  const initializeOnWorkerType = (message) => {
    if (!Array.isArray(message) || message[0] !== JEST_WORKER_INITIALIZE_MESSAGE) return

    process.removeListener('message', initializeOnWorkerType)
    if (!isJestAuxiliaryWorker(message[2])) {
      module.exports = initializeTracer()
    }
  }
  process.prependListener('message', initializeOnWorkerType)
  module.exports = {}
} else {
  module.exports = initializeTracer()
}

function isJestAuxiliaryWorker (workerPath) {
  if (typeof workerPath !== 'string') return false

  const normalizedWorkerPath = workerPath.replaceAll('\\', '/')
  return JEST_AUXILIARY_WORKER_PATHS.some(auxiliaryPath => normalizedWorkerPath.endsWith(auxiliaryPath))
}

function initializeTracer () {
  const exporters = require('../ext/exporters')
  const log = require('../packages/dd-trace/src/log')
  const { getEnvironmentVariable, getValueFromEnvSources } = require('../packages/dd-trace/src/config/helper')
  const { isFalse, isTrue } = require('../packages/dd-trace/src/util')
  const testWorkerType = detectTestWorkerType(getEnvironmentVariable, getValueFromEnvSources)
  const isTestWorker = testWorkerType !== null
  const isJestWorker = testWorkerType === 'jest'
  const exporterMap = {
    jest: exporters.JEST_WORKER,
    cucumber: exporters.CUCUMBER_WORKER,
    mocha: exporters.MOCHA_WORKER,
    playwright: exporters.PLAYWRIGHT_WORKER,
    vitest: exporters.VITEST_WORKER,
  }
  const baseOptions = {
    startupLogs: false,
    isCiVisibility: true,
    flushInterval: isJestWorker ? JEST_FLUSH_INTERVAL : DEFAULT_FLUSH_INTERVAL,
  }
  const isValidationModeRequested = isTrue(getEnvironmentVariable(VALIDATION_MODE_ENV))
  const missingValidationEnvironment = [VALIDATION_MANIFEST_ENV, VALIDATION_OUTPUT_ENV].filter(name => {
    return !getEnvironmentVariable(name)
  })
  const isValidationMode = isValidationModeRequested && missingValidationEnvironment.length === 0
  if (isValidationModeRequested && !isValidationMode) {
    console.error(
      `${VALIDATION_MODE_ENV} requires ${missingValidationEnvironment.join(' and ')}; ` +
      'dd-trace will not be initialized.'
    )
  }

  // skipDefault: Test Optimization stays on unless DD_CIVISIBILITY_ENABLED is explicitly false; the
  // registered default (false) would otherwise turn it off whenever the variable is unset.
  let shouldInit = isValidationModeRequested
    ? isValidationMode && !isFalse(getEnvironmentVariable('DD_CIVISIBILITY_ENABLED'))
    : getValueFromEnvSources('DD_CIVISIBILITY_ENABLED', true) !== false
  const isAgentlessEnabled = getValueFromEnvSources('DD_CIVISIBILITY_AGENTLESS_ENABLED')

  if (!isTestWorker && isPackageManager()) {
    log.debug('dd-trace is not initialized in a package manager.')
    shouldInit = false
  }

  if (isTestWorker) {
    baseOptions.experimental = {
      exporter: exporterMap[testWorkerType],
    }
  } else if (isValidationMode) {
    baseOptions.experimental = {
      exporter: 'ci_validation',
    }
  } else if (isAgentlessEnabled) {
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

  const skipVitestWorkerInit = shouldSkipVitestWorkerInit(getValueFromEnvSources, isTrue)
  if (skipVitestWorkerInit) {
    return {
      init () {},
      use () {},
    }
  }

  const tracer = require('../packages/dd-trace')
  if (shouldInit) {
    tracer.init(baseOptions)
    tracer.use('fs', false)
    tracer.use('child_process', false)
  }
  return tracer
}

function detectTestWorkerType (getEnvironmentVariable, getValueFromEnvSources) {
  if (getEnvironmentVariable('JEST_WORKER_ID')) return 'jest'
  if (getEnvironmentVariable('CUCUMBER_WORKER_ID')) return 'cucumber'
  if (getEnvironmentVariable('MOCHA_WORKER_ID')) return 'mocha'
  if (getValueFromEnvSources('DD_PLAYWRIGHT_WORKER')) return 'playwright'
  if (getEnvironmentVariable('TINYPOOL_WORKER_ID')) return 'vitest'
  if (getValueFromEnvSources('DD_VITEST_WORKER')) return 'vitest'
  return null
}

function shouldSkipVitestWorkerInit (getValueFromEnvSources, isTrue) {
  return getValueFromEnvSources('DD_VITEST_WORKER') &&
    isVitestNoWorkerInitActive(isTrue)
}

function isVitestNoWorkerInitActive (isTrue) {
  return isTrue(process.env[VITEST_NO_WORKER_INIT_ACTIVE_ENV])
}
