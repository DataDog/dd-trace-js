'use strict'

const { AsyncResource } = require('node:async_hooks')
const { fileURLToPath } = require('node:url')

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const log = require('../../dd-trace/src/log')
const {
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  TEST_SUITE_EXECUTION_ID,
} = require('../../dd-trace/src/plugins/util/test')
const { addHook, channel, tracingChannel } = require('./helpers/instrument')
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
const libraryConfigurationCh = channel('ci:mocha:library-configuration')
const workerReportTraceCh = channel('ci:mocha:worker-report:trace')

const localRunnerRunCh = tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_run')
const localRunnerShutdownCh = tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_shutdown')

const NODE_OPTIONS_SEPARATOR_RE = /\s/
const TEST_FRAMEWORK = 'webdriverio'

const loadCh = channel('dd-trace:instrumentation:load')
if (loadCh.hasSubscribers) {
  loadCh.publish({ name: '@wdio/local-runner' })
}

const coordinatorStates = new WeakMap()
const localRunnerVersions = new WeakMap()

addHook({
  name: '@wdio/local-runner',
  versions: ['>=9.0.0'],
  file: 'build/index.js',
  patchDefault: true,
}, (LocalRunner, version) => {
  localRunnerVersions.set(LocalRunner, version)
  return LocalRunner
})

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
 * @property {Map<string, WebdriverioSuiteContext>} suiteContexts
 * @property {string} testSuiteExecutionId
 * @property {boolean|undefined} hasTests
 * @property {number|undefined} exitCode
 * @property {number|undefined} retries
 */

/**
 * @typedef {object} WebdriverioSuiteContext
 * @property {object|undefined} currentStore
 * @property {string|undefined} status
 * @property {string} testSuiteAbsolutePath
 * @property {string} testSuiteExecutionId
 */

/**
 * @typedef {object} CoordinatorState
 * @property {WebdriverioLocalRunner} localRunner
 * @property {AsyncResource} asyncResource
 * @property {object} configuration
 * @property {boolean} initialized
 * @property {boolean} initializing
 * @property {Array<(configuration: object) => void>} initializationCallbacks
 * @property {boolean} sessionStarted
 * @property {boolean} finished
 * @property {string|undefined} frameworkVersion
 * @property {string} testFrameworkAdapter
 * @property {number} activeWorkers
 * @property {number} maxActiveWorkers
 * @property {number} nextWorkerId
 * @property {unknown} runError
 * @property {Set<WorkerRecord>} workers
 * @property {Map<object, string>} suiteStatuses
 */

/**
 * Creates the basic-reporting configuration consumed by Mocha workers.
 *
 * Advanced Test Optimization features remain disabled until they have WebdriverIO-specific coverage.
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
    asyncResource: new AsyncResource('dd-trace-webdriverio-coordinator'),
    configuration: createWorkerConfiguration(),
    initialized: false,
    initializing: false,
    initializationCallbacks: [],
    sessionStarted: false,
    finished: false,
    frameworkVersion: localRunnerVersions.get(localRunner.constructor),
    testFrameworkAdapter: getRunnerConfiguration(localRunner)?.framework,
    activeWorkers: 0,
    maxActiveWorkers: 0,
    nextWorkerId: 0,
    runError: undefined,
    workers: new Set(),
    suiteStatuses: new Map(),
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
 * Checks whether worker NODE_OPTIONS contain the complete launcher options.
 *
 * @param {string|undefined} workerNodeOptions
 * @param {string} launcherNodeOptions
 * @returns {boolean}
 */
function includesNodeOptions (workerNodeOptions, launcherNodeOptions) {
  if (!workerNodeOptions) {
    return false
  }

  let index = workerNodeOptions.indexOf(launcherNodeOptions)
  while (index !== -1) {
    const endIndex = index + launcherNodeOptions.length
    const startsAtBoundary = index === 0 || NODE_OPTIONS_SEPARATOR_RE.test(workerNodeOptions[index - 1])
    const endsAtBoundary = endIndex === workerNodeOptions.length ||
      NODE_OPTIONS_SEPARATOR_RE.test(workerNodeOptions[endIndex])

    if (startsAtBoundary && endsAtBoundary) {
      return true
    }
    index = workerNodeOptions.indexOf(launcherNodeOptions, index + 1)
  }
  return false
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
    testFramework: TEST_FRAMEWORK,
    testFrameworkAdapter: state.testFrameworkAdapter,
  })
  state.sessionStarted = true
}

/**
 * Completes coordinator initialization and releases waiting workers.
 *
 * @param {CoordinatorState} state
 * @param {object|undefined} response
 * @returns {void}
 */
function completeCoordinatorInitialization (state, response) {
  if (state.initialized) {
    return
  }

  state.configuration.repositoryRoot = response?.repositoryRoot
  state.initialized = true
  state.initializing = false
  startSession(state)

  const callbacks = state.initializationCallbacks
  state.initializationCallbacks = []
  for (const callback of callbacks) {
    callback(state.configuration)
  }
}

/**
 * Requests settings once so the launcher owns initialization for every worker.
 *
 * Settings for advanced features are intentionally ignored while WebdriverIO support is basic-reporting only.
 *
 * @param {CoordinatorState} state
 * @param {(configuration: object) => void} [onDone]
 * @returns {void}
 */
function initializeCoordinator (state, onDone) {
  if (state.initialized) {
    onDone?.(state.configuration)
    return
  }
  if (onDone) {
    state.initializationCallbacks.push(onDone)
  }
  if (state.initializing) {
    return
  }

  state.initializing = true
  if (!libraryConfigurationCh.hasSubscribers) {
    completeCoordinatorInitialization(state)
    return
  }

  try {
    libraryConfigurationCh.runStores({
      basicReportingOnly: true,
      frameworkVersion: state.frameworkVersion,
      isParallel: state.maxActiveWorkers > 1,
      onDone: response => state.asyncResource.runInAsyncScope(
        completeCoordinatorInitialization,
        undefined,
        state,
        response
      ),
    }, () => {})
  } catch (error) {
    log.error('WebdriverIO Test Optimization configuration error', error)
    completeCoordinatorInitialization(state)
  }
}

/**
 * Starts basic-reporting suites for one worker.
 *
 * @param {WorkerRecord} workerRecord
 * @param {string[]} files
 * @returns {void}
 */
function startWorkerSuites (workerRecord, files) {
  for (const rawFile of files) {
    const file = normalizeFile(rawFile)
    if (workerRecord.suiteContexts.has(file)) {
      continue
    }

    const suiteContext = {
      testSuiteAbsolutePath: file,
      testSuiteExecutionId: workerRecord.testSuiteExecutionId,
    }
    testSuiteStartCh.runStores(suiteContext, () => {})
    workerRecord.suiteContexts.set(file, suiteContext)
  }
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
  let hasFailedSuite = false
  for (const suiteContext of workerRecord.suiteContexts.values()) {
    if (suiteContext.status === 'fail') {
      hasFailedSuite = true
      break
    }
  }

  for (const [file, suiteContext] of workerRecord.suiteContexts) {
    let suiteStatus = suiteContext.status ?? status
    if (status === 'fail' && !hasFailedSuite && suiteStatus === 'skip') {
      suiteStatus = 'fail'
    }
    finishWorkerSuite(state, workerRecord, file, suiteStatus)
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
  const { files = [], requestId } = message.content || {}

  initializeCoordinator(state, (configuration) => {
    startWorkerSuites(workerRecord, files)
    sendWorkerMessage(workerRecord, {
      origin: 'datadog',
      name: CONFIGURATION_RESPONSE,
      content: {
        configuration,
        requestId,
      },
    })
  })
}

/**
 * Handles suite results reported by a Mocha worker.
 *
 * @param {WorkerRecord} workerRecord
 * @param {object} message
 * @returns {void}
 */
function handleSuiteResults (workerRecord, message) {
  const { results = [] } = message.content || {}
  for (const { file, status } of results) {
    const suiteContext = workerRecord.suiteContexts.get(normalizeFile(file))
    if (suiteContext) {
      suiteContext.status = status
    }
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
      workerReportTraceCh.publish({
        traces: payload,
        [TEST_SUITE_EXECUTION_ID]: workerRecord.testSuiteExecutionId,
      })
    }
    return
  }

  if (message.name === WORKER_READY) {
    initializeCoordinator(state)
    return
  }
  if (message.name === CONFIGURATION_REQUEST) {
    handleConfigurationRequest(state, workerRecord, message)
    return
  }
  if (message.name === SUITE_FINISH) {
    handleSuiteResults(workerRecord, message)
    return
  }
  if (message.name === 'testFrameworkInit') {
    workerRecord.hasTests = message.content?.hasTests
    if (!workerRecord.hasTests && state.frameworkVersion) {
      initializeCoordinator(state, () => {
        startWorkerSuites(workerRecord, workerRecord.specs)
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
  state.activeWorkers--
  workerRecord.exitCode = exit.exitCode
  workerRecord.retries = exit.retries
  if (!state.sessionStarted) {
    return
  }

  const status = workerRecord.hasTests === false ? 'skip' : exit.exitCode === 0 ? 'pass' : 'fail'
  if (status === 'fail' && workerRecord.suiteContexts.size === 0) {
    startWorkerSuites(workerRecord, workerRecord.specs)
  }
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
    normalizedSpecs.push(normalizeFile(spec))
  }

  const workerRecord = {
    worker,
    specs: normalizedSpecs,
    suiteContexts: new Map(),
    testSuiteExecutionId: String(++state.nextWorkerId),
    hasTests: undefined,
    exitCode: undefined,
    retries: undefined,
  }
  state.activeWorkers++
  if (state.activeWorkers > state.maxActiveWorkers) {
    state.maxActiveWorkers = state.activeWorkers
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

  for (const workerRecord of state.workers) {
    if (workerRecord.exitCode !== undefined && workerRecord.exitCode !== 0) {
      if (workerRecord.retries > 0) {
        continue
      }
      return 'fail'
    }
    for (const suiteContext of workerRecord.suiteContexts.values()) {
      const status = state.suiteStatuses.get(suiteContext)
      if (status === 'fail') {
        return 'fail'
      }
      if (status === 'pass') {
        hasPassingSuite = true
      }
    }
  }

  return hasPassingSuite ? 'pass' : 'skip'
}

/**
 * Finishes the single WebdriverIO-owned Mocha session.
 *
 * @param {CoordinatorState} state
 * @param {unknown} error
 * @param {() => void} onDone
 * @returns {void}
 */
function finishCoordinator (state, error, onDone) {
  if (state.finished) {
    onDone()
    return
  }
  if (!state.sessionStarted) {
    if (!error && getSessionStatus(state) !== 'fail') {
      onDone()
      return
    }
    initializeCoordinator(state, () => finishCoordinator(state, error, onDone))
    return
  }
  state.finished = true

  for (const workerRecord of state.workers) {
    const status = workerRecord.hasTests === false
      ? 'skip'
      : workerRecord.exitCode === 0 ? 'pass' : 'fail'
    finishAllWorkerSuites(state, workerRecord, status)
  }

  if (!testSessionFinishCh.hasSubscribers) {
    onDone()
    return
  }

  testSessionFinishCh.publish({
    status: error ? 'fail' : getSessionStatus(state),
    error,
    isParallel: state.maxActiveWorkers > 1,
    onDone,
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
    let workerEnvironment = runnerConfiguration.runnerEnv || {}
    const launcherNodeOptions = getEnvironmentVariable('NODE_OPTIONS')
    const workerNodeOptions = workerEnvironment.NODE_OPTIONS

    if (launcherNodeOptions && !includesNodeOptions(workerNodeOptions, launcherNodeOptions)) {
      workerEnvironment = {
        ...workerEnvironment,
        NODE_OPTIONS: workerNodeOptions
          ? `${launcherNodeOptions} ${workerNodeOptions}`
          : launcherNodeOptions,
      }
    }

    runnerConfiguration.runnerEnv = {
      ...workerEnvironment,
      MOCHA_WORKER_ID: 'webdriverio',
      [WEBDRIVERIO_WORKER_ENV]: 'true',
    }
    context.ddCoordinatorState = state
    context.ddWorkerSpecs = workerOptions?.specs || []
  },
  asyncEnd (context) {
    const state = context.ddCoordinatorState
    if (!state) {
      return
    }
    if (context.error) {
      state.runError ??= context.error
      return
    }
    if (!context.result) {
      return
    }
    registerWorker(state, context.result, context.ddWorkerSpecs)
  },
})

// @ts-expect-error See the partial tracing-channel subscriber above.
localRunnerShutdownCh.subscribe({
  asyncEnd (context) {
    const state = coordinatorStates.get(context.self)
    if (!state) {
      return
    }

    // Orchestrion uses the callback for the matching settlement path to delay LocalRunner.shutdown.
    const waitForCoordinator = onDone => {
      const error = context.error ?? state.runError
      if (state.initializing) {
        state.initializationCallbacks.push(() => finishCoordinator(state, error, onDone))
      } else {
        finishCoordinator(state, error, onDone)
      }
    }
    context.resolveCallback = waitForCoordinator
    context.rejectCallback = waitForCoordinator
  },
})
