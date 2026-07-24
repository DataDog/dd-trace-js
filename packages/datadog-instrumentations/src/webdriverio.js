'use strict'

const { fileURLToPath } = require('node:url')

const { isMarkedAsUnskippable } = require('../../datadog-plugin-jest/src/util')
const log = require('../../dd-trace/src/log')
const {
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  collectTestOptimizationSummariesFromTraces,
  getIsFaultyEarlyFlakeDetection,
  getTestOptimizationRequestResults,
  getTestSuitePath,
  logTestOptimizationSummary,
} = require('../../dd-trace/src/plugins/util/test')
const { channel, tracingChannel } = require('./helpers/instrument')
const {
  attemptToFixExecutions,
  loggedAttemptToFixTests,
  newTestsWithDynamicNames,
} = require('./mocha/utils')
const {
  CONFIGURATION_REQUEST,
  CONFIGURATION_RESPONSE,
  SUITE_FINISH,
  WEBDRIVERIO_WORKER_ENV,
  WORKER_READY,
} = require('./mocha/webdriverio-protocol')

const testFinishCh = channel('ci:mocha:test:finish')
const testSessionStartCh = channel('ci:mocha:session:start')
const testSessionFinishCh = channel('ci:mocha:session:finish')
const testSuiteStartCh = channel('ci:mocha:test-suite:start')
const testSuiteFinishCh = channel('ci:mocha:test-suite:finish')
const itrSkippedSuitesCh = channel('ci:mocha:itr:skipped-suites')
const libraryConfigurationCh = channel('ci:mocha:library-configuration')
const knownTestsCh = channel('ci:mocha:known-tests')
const modifiedFilesCh = channel('ci:mocha:modified-files')
const skippableSuitesCh = channel('ci:mocha:test-suite:skippable')
const testManagementTestsCh = channel('ci:mocha:test-management-tests')
const workerReportTraceCh = channel('ci:mocha:worker-report:trace')

const localRunnerRunCh = tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_run')
const localRunnerShutdownCh = tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_shutdown')

const loadCh = channel('dd-trace:instrumentation:load')
if (loadCh.hasSubscribers) {
  loadCh.publish({ name: '@wdio/local-runner' })
}

const coordinatorStates = new WeakMap()

/**
 * @typedef {object} WebdriverioRunnerConfig
 * @property {string} framework
 * @property {string|undefined} rootDir
 * @property {NodeJS.ProcessEnv|undefined} runnerEnv
 */

/**
 * @typedef {object} WebdriverioLocalRunner
 * @property {WebdriverioRunnerConfig|undefined} config
 * @property {WebdriverioRunnerConfig|undefined} _config
 */

/**
 * @typedef {object} WorkerRecord
 * @property {object} worker
 * @property {string[]} specs
 * @property {Map<string, object>} suiteContexts
 * @property {boolean|undefined} hasTests
 * @property {number|undefined} exitCode
 */

/**
 * @typedef {object} CoordinatorState
 * @property {WebdriverioLocalRunner} localRunner
 * @property {object} config
 * @property {Promise<object>|undefined} initializationPromise
 * @property {boolean} sessionStarted
 * @property {boolean} finished
 * @property {string|undefined} frameworkVersion
 * @property {Set<WorkerRecord>} workers
 * @property {Set<string>} scheduledFiles
 * @property {Set<string>} skippedSuites
 * @property {Set<string>} unskippableSuites
 * @property {string[]} suitesToSkip
 * @property {string} itrCorrelationId
 * @property {Map<object, string>} suiteStatuses
 * @property {boolean} hasForcedToRunSuites
 */

/**
 * Creates the configuration consumed by Mocha's worker instrumentation.
 *
 * @returns {object}
 */
function createWorkerConfiguration () {
  return {
    earlyFlakeDetectionNumRetries: 0,
    earlyFlakeDetectionSlowTestRetries: {},
    flakyTestRetriesCount: 0,
    isCodeCoverageEnabled: false,
    isCoverageReportUploadEnabled: false,
    isDiEnabled: false,
    isEarlyFlakeDetectionEnabled: false,
    isEarlyFlakeDetectionFaulty: false,
    isFlakyTestRetriesEnabled: false,
    isImpactedTestsEnabled: false,
    isItrEnabled: false,
    isKnownTestsEnabled: false,
    isSuitesSkippingEnabled: false,
    isTestDynamicInstrumentationEnabled: false,
    isTestManagementTestsEnabled: false,
    knownTests: {},
    modifiedFiles: [],
    repositoryRoot: undefined,
    testManagementAttemptToFixRetries: 0,
    testManagementTests: {},
  }
}

/**
 * Gets the public runner configuration, or the private equivalent used by older releases.
 *
 * @param {WebdriverioLocalRunner} localRunner
 * @returns {WebdriverioRunnerConfig|undefined}
 */
function getRunnerConfiguration (localRunner) {
  return localRunner.config || localRunner._config
}

/**
 * Gets or creates coordinator state for a WebdriverIO local runner.
 *
 * @param {WebdriverioLocalRunner} localRunner
 * @returns {CoordinatorState}
 */
function getCoordinatorState (localRunner) {
  let state = coordinatorStates.get(localRunner)
  if (state) {
    return state
  }

  state = {
    localRunner,
    config: createWorkerConfiguration(),
    initializationPromise: undefined,
    sessionStarted: false,
    finished: false,
    frameworkVersion: undefined,
    workers: new Set(),
    scheduledFiles: new Set(),
    skippedSuites: new Set(),
    unskippableSuites: new Set(),
    suitesToSkip: [],
    itrCorrelationId: '',
    suiteStatuses: new Map(),
    hasForcedToRunSuites: false,
  }
  coordinatorStates.set(localRunner, state)

  return state
}

/**
 * Normalizes a WebdriverIO spec identifier to a filesystem path.
 *
 * @param {string} file
 * @returns {string}
 */
function normalizeFile (file) {
  return file.startsWith('file://') ? fileURLToPath(file) : file
}

/**
 * Requests data through a Test Optimization diagnostic channel.
 *
 * @param {import('node:diagnostics_channel').Channel} requestChannel
 * @param {object} [context]
 * @returns {Promise<object>}
 */
function getChannelPromise (requestChannel, context = {}) {
  return new Promise(resolve => {
    requestChannel.runStores({ ...context, onDone: resolve }, () => {})
  })
}

/**
 * Applies the library configuration fields used by Mocha workers.
 *
 * @param {CoordinatorState} state
 * @param {object} libraryConfig
 * @param {boolean} isTestDynamicInstrumentationEnabled
 * @returns {void}
 */
function applyLibraryConfiguration (state, libraryConfig, isTestDynamicInstrumentationEnabled) {
  const { config } = state

  config.earlyFlakeDetectionFaultyThreshold = libraryConfig.earlyFlakeDetectionFaultyThreshold
  config.earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries
  config.earlyFlakeDetectionSlowTestRetries = libraryConfig.earlyFlakeDetectionSlowTestRetries ?? {}
  config.flakyTestRetriesCount = libraryConfig.flakyTestRetriesCount
  config.isCodeCoverageEnabled = libraryConfig.isCodeCoverageEnabled
  config.isCoverageReportUploadEnabled = libraryConfig.isCoverageReportUploadEnabled
  config.isDiEnabled = libraryConfig.isDiEnabled
  config.isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
  config.isFlakyTestRetriesEnabled = libraryConfig.isFlakyTestRetriesEnabled
  config.isImpactedTestsEnabled = libraryConfig.isImpactedTestsEnabled
  config.isItrEnabled = libraryConfig.isItrEnabled
  config.isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
  config.isSuitesSkippingEnabled = config.isItrEnabled && libraryConfig.isSuitesSkippingEnabled
  config.isTestDynamicInstrumentationEnabled = isTestDynamicInstrumentationEnabled
  config.isTestManagementTestsEnabled = libraryConfig.isTestManagementEnabled
  config.testManagementAttemptToFixRetries = libraryConfig.testManagementAttemptToFixRetries
}

/**
 * Applies known-tests request results to worker configuration.
 *
 * @param {CoordinatorState} state
 * @param {object|undefined} response
 * @returns {void}
 */
function applyKnownTestsResponse (state, response) {
  if (!response) {
    return
  }
  if (response.err) {
    state.config.isEarlyFlakeDetectionEnabled = false
    state.config.isKnownTestsEnabled = false
    state.config.knownTests = {}
  } else {
    state.config.knownTests = response.knownTests
  }
}

/**
 * Applies test-management request results to worker configuration.
 *
 * @param {CoordinatorState} state
 * @param {object|undefined} response
 * @returns {void}
 */
function applyTestManagementResponse (state, response) {
  if (!response) {
    return
  }
  if (response.err) {
    state.config.isTestManagementTestsEnabled = false
    state.config.testManagementAttemptToFixRetries = 0
    state.config.testManagementTests = {}
  } else {
    state.config.testManagementTests = response.testManagementTests
  }
}

/**
 * Applies skippable-suite request results to coordinator state.
 *
 * @param {CoordinatorState} state
 * @param {object|undefined} response
 * @returns {void}
 */
function applySkippableSuitesResponse (state, response) {
  if (!response || response.err) {
    state.suitesToSkip = []
    return
  }

  state.suitesToSkip = response.skippableSuites || []
  state.itrCorrelationId = response.itrCorrelationId || ''
}

/**
 * Fetches all Test Optimization settings required by WebdriverIO Mocha workers.
 *
 * @param {CoordinatorState} state
 * @returns {Promise<object>}
 */
function getExecutionConfiguration (state) {
  const context = {
    frameworkVersion: state.frameworkVersion,
    isParallel: true,
  }

  return getChannelPromise(libraryConfigurationCh, context).then(({
    err,
    isTestDynamicInstrumentationEnabled,
    libraryConfig,
    repositoryRoot,
  }) => {
    if (err || !libraryConfig) {
      return state.config
    }

    state.config.repositoryRoot = repositoryRoot
    applyLibraryConfiguration(state, libraryConfig, isTestDynamicInstrumentationEnabled)

    return getTestOptimizationRequestResults({
      isKnownTestsEnabled: state.config.isKnownTestsEnabled,
      isTestManagementTestsEnabled: state.config.isTestManagementTestsEnabled,
      isSuitesSkippingEnabled: state.config.isSuitesSkippingEnabled,
      getKnownTests: () => getChannelPromise(knownTestsCh, context),
      getSkippableSuites: () => getChannelPromise(skippableSuitesCh, context),
      getTestManagementTests: () => getChannelPromise(testManagementTestsCh, context),
    }).then(({
      knownTestsResponse,
      skippableSuitesResponse,
      testManagementTestsResponse,
    }) => {
      applyKnownTestsResponse(state, knownTestsResponse)
      applySkippableSuitesResponse(state, skippableSuitesResponse)
      applyTestManagementResponse(state, testManagementTestsResponse)

      if (!state.config.isImpactedTestsEnabled) {
        return state.config
      }

      return getChannelPromise(modifiedFilesCh, context).then(({ err, modifiedFiles }) => {
        if (err) {
          state.config.isImpactedTestsEnabled = false
          state.config.modifiedFiles = []
        } else {
          state.config.modifiedFiles = modifiedFiles
        }
        return state.config
      })
    })
  })
}

/**
 * Checks whether the known-tests response is faulty for the currently scheduled specs.
 *
 * @param {CoordinatorState} state
 * @returns {void}
 */
function checkKnownTestsResponse (state) {
  if (!state.config.isKnownTestsEnabled) {
    return
  }

  const localSuites = []
  for (const file of state.scheduledFiles) {
    localSuites.push(getTestSuitePath(file, process.cwd()))
  }

  if (getIsFaultyEarlyFlakeDetection(
    localSuites,
    state.config.knownTests?.mocha || {},
    state.config.earlyFlakeDetectionFaultyThreshold
  )) {
    state.config.isEarlyFlakeDetectionEnabled = false
    state.config.isEarlyFlakeDetectionFaulty = true
    state.config.isKnownTestsEnabled = false
  }
}

/**
 * Starts the single Mocha session owned by the WebdriverIO launcher.
 *
 * @param {CoordinatorState} state
 * @returns {void}
 */
function startSession (state) {
  if (state.sessionStarted) {
    return
  }

  const processArgv = process.argv.slice(2).join(' ')
  const command = processArgv ? `wdio ${processArgv}` : 'wdio'
  const rootDir = getRunnerConfiguration(state.localRunner)?.rootDir || process.cwd()

  testSessionStartCh.publish({
    command,
    frameworkVersion: state.frameworkVersion,
    rootDir,
  })
  state.sessionStarted = true
}

/**
 * Initializes configuration and session state once for all workers.
 *
 * @param {CoordinatorState} state
 * @param {string} frameworkVersion
 * @returns {Promise<object>}
 */
function initializeCoordinator (state, frameworkVersion) {
  if (state.initializationPromise) {
    return state.initializationPromise
  }

  state.frameworkVersion = frameworkVersion
  state.initializationPromise = getExecutionConfiguration(state)
    .catch((error) => {
      log.error('WebdriverIO Test Optimization configuration error', error)
      return state.config
    })
    .then((configuration) => {
      checkKnownTestsResponse(state)
      startSession(state)
      return configuration
    })

  return state.initializationPromise
}

/**
 * Determines and publishes suite selection for one worker.
 *
 * @param {CoordinatorState} state
 * @param {WorkerRecord} workerRecord
 * @param {string[]} files
 * @returns {string[]}
 */
function startWorkerSuites (state, workerRecord, files) {
  const suitesToSkip = new Set(state.suitesToSkip)
  const skippedFiles = []
  const newlySkippedSuites = []

  for (const rawFile of files) {
    const file = normalizeFile(rawFile)
    const testSuite = getTestSuitePath(file, process.cwd())
    const isUnskippable = isMarkedAsUnskippable({ path: file })
    const shouldSkip = state.config.isSuitesSkippingEnabled && suitesToSkip.has(testSuite)

    if (isUnskippable) {
      state.unskippableSuites.add(file)
    }
    if (shouldSkip && !isUnskippable) {
      skippedFiles.push(file)
      if (!state.skippedSuites.has(testSuite)) {
        state.skippedSuites.add(testSuite)
        newlySkippedSuites.push(testSuite)
      }
      continue
    }
    if (workerRecord.suiteContexts.has(file)) {
      continue
    }

    const suiteContext = {
      testSuiteAbsolutePath: file,
      isUnskippable,
      isForcedToRun: shouldSkip && isUnskippable,
      itrCorrelationId: state.itrCorrelationId,
    }
    if (suiteContext.isForcedToRun) {
      state.hasForcedToRunSuites = true
    }
    testSuiteStartCh.runStores(suiteContext, () => {})
    workerRecord.suiteContexts.set(file, suiteContext)
  }

  if (newlySkippedSuites.length) {
    itrSkippedSuitesCh.publish({
      skippedSuites: newlySkippedSuites,
      frameworkVersion: state.frameworkVersion,
    })
  }

  return skippedFiles
}

/**
 * Finishes one suite if it is still active.
 *
 * @param {CoordinatorState} state
 * @param {WorkerRecord} workerRecord
 * @param {string} rawFile
 * @param {string} status
 * @returns {void}
 */
function finishWorkerSuite (state, workerRecord, rawFile, status) {
  const file = normalizeFile(rawFile)
  const suiteContext = workerRecord.suiteContexts.get(file)
  if (!suiteContext || state.suiteStatuses.has(suiteContext)) {
    return
  }

  state.suiteStatuses.set(suiteContext, status)
  testSuiteFinishCh.publish({ status, ...suiteContext.currentStore })
}

/**
 * Finishes every active suite belonging to a worker.
 *
 * @param {CoordinatorState} state
 * @param {WorkerRecord} workerRecord
 * @param {string} status
 * @returns {void}
 */
function finishAllWorkerSuites (state, workerRecord, status) {
  for (const file of workerRecord.suiteContexts.keys()) {
    finishWorkerSuite(state, workerRecord, file, status)
  }
}

/**
 * Sends a coordinator message to a WebdriverIO child process.
 *
 * @param {WorkerRecord} workerRecord
 * @param {object} message
 * @returns {void}
 */
function sendWorkerMessage (workerRecord, message) {
  const childProcess = workerRecord.worker.childProcess
  if (!childProcess?.connected) {
    return
  }

  childProcess.send(message, (error) => {
    if (error) {
      log.error('WebdriverIO Test Optimization IPC error', error)
    }
  })
}

/**
 * Handles a worker request for its Mocha execution configuration.
 *
 * @param {CoordinatorState} state
 * @param {WorkerRecord} workerRecord
 * @param {object} message
 * @returns {void}
 */
function handleConfigurationRequest (state, workerRecord, message) {
  const { files = [], frameworkVersion, requestId } = message.content || {}

  initializeCoordinator(state, frameworkVersion).then(() => {
    const skippedFiles = startWorkerSuites(state, workerRecord, files)
    sendWorkerMessage(workerRecord, {
      origin: 'datadog',
      name: CONFIGURATION_RESPONSE,
      content: {
        configuration: state.config,
        requestId,
        skippedFiles,
      },
    })
  })
}

/**
 * Handles suite results reported by a Mocha worker.
 *
 * @param {CoordinatorState} state
 * @param {WorkerRecord} workerRecord
 * @param {object} message
 * @returns {void}
 */
function handleSuiteResults (state, workerRecord, message) {
  const { results = [] } = message.content || {}
  for (const { file, status } of results) {
    finishWorkerSuite(state, workerRecord, file, status)
  }
}

/**
 * Handles all messages emitted by one WebdriverIO child process.
 *
 * @param {CoordinatorState} state
 * @param {WorkerRecord} workerRecord
 * @param {object|unknown[]} message
 * @returns {void}
 */
function handleWorkerMessage (state, workerRecord, message) {
  if (Array.isArray(message)) {
    const [messageCode, payload] = message
    if (messageCode === MOCHA_WORKER_TRACE_PAYLOAD_CODE) {
      collectTestOptimizationSummariesFromTraces(payload, {
        attemptToFixExecutions,
        newTestsWithDynamicNames,
      })
      workerReportTraceCh.publish(payload)
    }
    return
  }

  if (message.name === WORKER_READY) {
    initializeCoordinator(state, message.content?.frameworkVersion)
    return
  }
  if (message.name === CONFIGURATION_REQUEST) {
    handleConfigurationRequest(state, workerRecord, message)
    return
  }
  if (message.name === SUITE_FINISH) {
    handleSuiteResults(state, workerRecord, message)
    return
  }
  if (message.name === 'testFrameworkInit') {
    workerRecord.hasTests = message.content?.hasTests
    if (!workerRecord.hasTests && state.frameworkVersion) {
      initializeCoordinator(state, state.frameworkVersion).then(() => {
        startWorkerSuites(state, workerRecord, workerRecord.specs)
        finishAllWorkerSuites(state, workerRecord, 'skip')
      })
    }
  }
}

/**
 * Handles child-process exit and closes suites missing an explicit result.
 *
 * @param {CoordinatorState} state
 * @param {WorkerRecord} workerRecord
 * @param {object} exit
 * @returns {void}
 */
function handleWorkerExit (state, workerRecord, exit) {
  workerRecord.exitCode = exit.exitCode
  if (!state.sessionStarted) {
    return
  }

  const status = workerRecord.hasTests === false ? 'skip' : exit.exitCode === 0 ? 'pass' : 'fail'
  finishAllWorkerSuites(state, workerRecord, status)
}

/**
 * Registers a newly created WebdriverIO worker with the coordinator.
 *
 * @param {CoordinatorState} state
 * @param {object} worker
 * @param {string[]} specs
 * @returns {void}
 */
function registerWorker (state, worker, specs) {
  const normalizedSpecs = []
  for (const spec of specs) {
    const file = normalizeFile(spec)
    normalizedSpecs.push(file)
    state.scheduledFiles.add(file)
  }

  const workerRecord = {
    worker,
    specs: normalizedSpecs,
    suiteContexts: new Map(),
    hasTests: undefined,
    exitCode: undefined,
  }
  state.workers.add(workerRecord)

  worker.on('message', message => handleWorkerMessage(state, workerRecord, message))
  worker.once('exit', exit => handleWorkerExit(state, workerRecord, exit))
}

/**
 * Calculates the final status for the coordinated session.
 *
 * @param {CoordinatorState} state
 * @returns {string}
 */
function getSessionStatus (state) {
  let hasPassingSuite = false

  for (const status of state.suiteStatuses.values()) {
    if (status === 'fail') {
      return 'fail'
    }
    if (status === 'pass') {
      hasPassingSuite = true
    }
  }

  return hasPassingSuite ? 'pass' : 'skip'
}

/**
 * Finishes the single WebdriverIO-owned Mocha session.
 *
 * @param {CoordinatorState} state
 * @param {unknown} error
 * @returns {Promise<void>}
 */
function finishCoordinator (state, error) {
  if (state.finished || !state.sessionStarted) {
    return Promise.resolve()
  }
  state.finished = true

  for (const workerRecord of state.workers) {
    const status = workerRecord.hasTests === false
      ? 'skip'
      : workerRecord.exitCode === 0 ? 'pass' : 'fail'
    finishAllWorkerSuites(state, workerRecord, status)
  }

  const status = error ? 'fail' : getSessionStatus(state)
  if (!testSessionFinishCh.hasSubscribers) {
    return Promise.resolve()
  }

  return new Promise(resolve => {
    testSessionFinishCh.publish({
      status,
      isSuitesSkipped: state.skippedSuites.size > 0,
      numSkippedSuites: state.skippedSuites.size,
      hasForcedToRunSuites: state.hasForcedToRunSuites,
      hasUnskippableSuites: state.unskippableSuites.size > 0,
      error,
      isEarlyFlakeDetectionEnabled: state.config.isEarlyFlakeDetectionEnabled,
      isEarlyFlakeDetectionFaulty: state.config.isEarlyFlakeDetectionFaulty,
      isTestManagementEnabled: state.config.isTestManagementTestsEnabled,
      isParallel: state.workers.size > 1,
      onDone: resolve,
    })

    logTestOptimizationSummary({ attemptToFixExecutions, newTestsWithDynamicNames })
    loggedAttemptToFixTests.clear()
  })
}

// dc-polyfill supports partial tracing-channel subscribers, unlike the Node.js type definition.
// @ts-expect-error
localRunnerRunCh.subscribe({
  start (context) {
    const runnerConfiguration = getRunnerConfiguration(context.self)
    if (!testFinishCh.hasSubscribers || runnerConfiguration?.framework !== 'mocha') {
      return
    }

    const state = getCoordinatorState(context.self)
    const workerOptions = context.arguments?.[0]
    const runnerEnv = runnerConfiguration.runnerEnv || {}

    runnerConfiguration.runnerEnv = {
      ...runnerEnv,
      MOCHA_WORKER_ID: 'webdriverio',
      [WEBDRIVERIO_WORKER_ENV]: 'true',
    }
    context.ddCoordinatorState = state
    context.ddWorkerSpecs = workerOptions?.specs || []
  },
  asyncEnd (context) {
    if (!context.ddCoordinatorState || context.error || !context.result) {
      return
    }
    registerWorker(context.ddCoordinatorState, context.result, context.ddWorkerSpecs)
  },
})

// @ts-expect-error See the partial tracing-channel subscriber above.
localRunnerShutdownCh.subscribe({
  asyncEnd (context) {
    const state = coordinatorStates.get(context.self)
    if (!state) {
      return
    }

    context.asyncEndPromise = (state.initializationPromise || Promise.resolve())
      .then(() => finishCoordinator(state, context.error))
  },
})
