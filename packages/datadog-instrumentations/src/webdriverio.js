'use strict'

// Capture real timers at module load time before tests can install fake timers.
const realSetTimeout = setTimeout

const { AsyncResource } = require('node:async_hooks')
const { fileURLToPath } = require('node:url')

const { EMPTY_EFD_RETRY_POLICY } = require('../../dd-trace/src/ci-visibility/efd-retry-policy')
const { RUM_TEST_EXECUTION_ID_COOKIE_NAME } = require('../../dd-trace/src/ci-visibility/rum')
const { getEnvironmentVariable, getValueFromEnvSources } = require('../../dd-trace/src/config/helper')
const log = require('../../dd-trace/src/log')
const {
  collectTestOptimizationSummariesFromTraces,
  getIsFaultyEarlyFlakeDetection,
  getTestSuitePath,
  logTestOptimizationSummary,
  MOCHA_WORKER_LOGS_PAYLOAD_CODE,
  MOCHA_WORKER_TELEMETRY_PAYLOAD_CODE,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  TEST_SUITE_EXECUTION_ID,
} = require('../../dd-trace/src/plugins/util/test')
const { publishWithCompletion } = require('./helpers/channel')
const { addHook, channel, tracingChannel } = require('./helpers/instrument')
const {
  CONFIGURATION_REQUEST,
  CONFIGURATION_RESPONSE,
  sendWebdriverioWorkerMessage,
  SUITE_FINISH,
  WEBDRIVERIO_WORKER_ENV,
  WEBDRIVERIO_WORKER_EVENT,
  WEBDRIVERIO_WORKER_ORIGIN,
  WORKER_READY,
  WORKER_READY_RESPONSE,
} = require('./mocha/webdriverio-protocol')
const { detectRum, stopRumSession } = require('./rum-browser-scripts')

const jasmineDoneCh = channel('ci:webdriverio:jasmine:done')
const rumPageNavigateCh = channel('ci:webdriverio:rum:page-navigate')
const testFinishCh = channel('ci:mocha:test:finish')
const testSessionStartCh = channel('ci:mocha:session:start')
const testSessionFinishCh = channel('ci:mocha:session:finish')
const testSuiteErrorCh = channel('ci:mocha:test-suite:error')
const testSuiteStartCh = channel('ci:mocha:test-suite:start')
const testSuiteFinishCh = channel('ci:mocha:test-suite:finish')
const knownTestsCh = channel('ci:mocha:known-tests')
const libraryConfigurationCh = channel('ci:mocha:library-configuration')
const logSubmissionFlushCh = channel('ci:log-submission:flush')
const modifiedFilesCh = channel('ci:mocha:modified-files')
const testManagementTestsCh = channel('ci:mocha:test-management-tests')
const workerConfigurationCh = channel('ci:mocha:worker:configuration')
const workerReportLogsCh = channel('ci:mocha:worker-report:logs')
const workerReportTelemetryCh = channel('ci:mocha:worker-report:telemetry')
const workerReportTraceCh = channel('ci:mocha:worker-report:trace')

const jasmineAdapterInitCh = tracingChannel('orchestrion:@wdio/jasmine-framework:JasmineAdapter_init')
const baseReporterWaitForSyncCh = tracingChannel('orchestrion:@wdio/runner:BaseReporter_waitForSync')
const executeAsyncCh = tracingChannel('orchestrion:@wdio/utils:executeAsync')
const launcherStartInstanceCh = tracingChannel('orchestrion:@wdio/cli:Launcher_startInstance')
const localRunnerRunCh = tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_run')
const localRunnerShutdownCh = tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_shutdown')
const testFrameworkFnWrapperCh = tracingChannel('orchestrion:@wdio/utils:testFrameworkFnWrapper')
const urlCh = tracingChannel('orchestrion:webdriverio:url')

const NODE_OPTIONS_SEPARATOR_RE = /\s/
const JASMINE_FRAMEWORK_ADAPTER = 'jasmine'
const MOCHA_FRAMEWORK_ADAPTER = 'mocha'
const SUPPORTED_FRAMEWORK_ADAPTERS = new Set([JASMINE_FRAMEWORK_ADAPTER, MOCHA_FRAMEWORK_ADAPTER])
const TEST_FRAMEWORK = 'webdriverio'
const RUM_FLUSH_WAIT_TIME = getValueFromEnvSources('DD_CIVISIBILITY_RUM_FLUSH_WAIT_MILLIS')
const isWebdriverioWorker = !!getEnvironmentVariable(WEBDRIVERIO_WORKER_ENV)
let jasmineWorkerRequestId = 0

const loadCh = channel('dd-trace:instrumentation:load')
if (loadCh.hasSubscribers) {
  loadCh.publish({ name: '@wdio/local-runner' })
}

const coordinatorStates = new WeakMap()
const localRunnerVersions = new WeakMap()
const rumBrowsers = new Set()
const rumCorrelationBrowsers = new Set()
const sharedRumBrowsers = new WeakSet()
const rumBrowserPreloadScripts = new WeakMap()
const rumBrowserTestExecutionIds = new WeakMap()

/** @typedef {{done: boolean, value?: unknown}} RumGeneratorStep */
/**
 * @typedef {object} RumGenerator
 * @property {(value?: unknown) => RumGeneratorStep} next
 * @property {(error: unknown) => RumGeneratorStep} throw
 */

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
 * Installs RUM correlation on every subsequent document in the BiDi session.
 *
 * @param {object} browser
 * @param {string} testExecutionId
 * @yields {unknown} Browser command result.
 * @returns {RumGenerator}
 */
function * installRumPreloadScript (browser, testExecutionId) {
  if (!browser.isBidi ||
      typeof browser.scriptAddPreloadScript !== 'function') return

  try {
    if (rumBrowserPreloadScripts.has(browser)) return

    const cookie = `${RUM_TEST_EXECUTION_ID_COOKIE_NAME}=${testExecutionId}; path=/`
    const { script } = yield browser.scriptAddPreloadScript({
      functionDeclaration: `() => { globalThis.document.cookie = ${JSON.stringify(cookie)} }`,
    })
    rumBrowserPreloadScripts.set(browser, script)
  } catch (error) {
    log.error('WebdriverIO RUM correlation preload error', error)
  }
}

/**
 * Removes a browser-wide RUM correlation preload.
 *
 * @param {object} browser
 * @yields {unknown} Browser command result.
 * @returns {RumGenerator}
 */
function * removeRumPreloadScript (browser) {
  const script = rumBrowserPreloadScripts.get(browser)
  rumBrowserPreloadScripts.delete(browser)
  if (!script || typeof browser.scriptRemovePreloadScript !== 'function') return

  try {
    yield browser.scriptRemovePreloadScript({ script })
  } catch (error) {
    log.error('WebdriverIO RUM correlation preload cleanup error', error)
  }
}

/**
 * Gets the active test execution ID and applies browser metadata to its span.
 *
 * @param {object} browser
 * @param {boolean|undefined} isRumActive
 * @returns {string|undefined}
 */
function getRumTestExecutionId (browser, isRumActive) {
  const correlationContext = {
    browserName: browser.capabilities?.browserName,
    browserVersion: browser.capabilities?.browserVersion,
    isRumActive,
    testExecutionId: undefined,
  }
  try {
    rumPageNavigateCh.publish(correlationContext)
  } catch (error) {
    log.error('WebdriverIO RUM correlation channel error', error)
  }
  return correlationContext.testExecutionId
}

/**
 * Installs RUM correlation before a BiDi navigation starts.
 *
 * @this {object}
 * @yields {unknown} Browser command result.
 * @returns {RumGenerator}
 */
function * preloadRumNavigation () {
  const browser = this
  try {
    if (!browser?.isBidi ||
        typeof browser.scriptAddPreloadScript !== 'function') return

    const testExecutionId = getRumTestExecutionId(browser)
    if (!testExecutionId) return

    rumBrowsers.add(browser)
    rumCorrelationBrowsers.add(browser)
    rumBrowserTestExecutionIds.set(browser, testExecutionId)
    yield * installRumPreloadScript(browser, testExecutionId)
  } catch (error) {
    log.error('WebdriverIO RUM correlation preload error', error)
  }
}

/**
 * Correlates the current browser window with one test execution.
 *
 * @param {object} browser
 * @param {string} testExecutionId
 * @yields {unknown} Browser command result.
 * @returns {RumGenerator}
 */
function * correlateRumWindow (browser, testExecutionId) {
  try {
    yield browser.setCookies({
      name: RUM_TEST_EXECUTION_ID_COOKIE_NAME,
      value: testExecutionId,
    })
  } catch (error) {
    log.error('WebdriverIO RUM correlation cookie error', error)
  }
  yield * installRumPreloadScript(browser, testExecutionId)
}

/**
 * Detects RUM after a browser navigation and correlates it with the active test.
 *
 * @param {{self?: object}} context
 * @yields {unknown} Browser command result.
 * @returns {RumGenerator}
 */
function * handleRumNavigation (context) {
  const browser = context.self
  try {
    if (!browser || typeof browser.execute !== 'function') return

    let rumState
    try {
      rumState = yield browser.execute(detectRum)
    } catch (error) {
      log.error('WebdriverIO RUM detection error', error)
      return
    }

    if (!rumState) return

    const { isRumInstrumented, isRumActive, rumSamplingRate } = rumState
    if (isRumInstrumented && rumSamplingRate < 100 && !isRumActive) {
      log.debug("RUM was detected on the page, but it isn't active because the sampling rate is below 100%")
    }
    if (!isRumActive) return

    rumBrowsers.add(browser)
    const testExecutionId = getRumTestExecutionId(browser, isRumActive)
    if (!testExecutionId) {
      sharedRumBrowsers.add(browser)
      return
    }

    yield * correlateRumBrowser(browser, testExecutionId)
  } catch (error) {
    log.error('WebdriverIO RUM correlation error', error)
  }
}

/**
 * Stops RUM in the current window, waits for its events to flush, and removes the correlation cookie.
 *
 * @param {object} browser
 * @yields {unknown} Browser command result or timer callback.
 * @returns {RumGenerator}
 */
function * cleanupRumWindow (browser) {
  let isRumActive
  try {
    isRumActive = yield browser.execute(stopRumSession)
  } catch (error) {
    log.error('WebdriverIO RUM cleanup error', error)
  }

  if (isRumActive) {
    getRumTestExecutionId(browser, true)
    yield onDone => realSetTimeout(onDone, RUM_FLUSH_WAIT_TIME)
  }
  yield * deleteRumCookie(browser)
}

/**
 * Removes the RUM correlation cookie from the current window.
 *
 * @param {object} browser
 * @yields {unknown} Browser command result.
 * @returns {RumGenerator}
 */
function * deleteRumCookie (browser) {
  try {
    yield browser.deleteCookies(RUM_TEST_EXECUTION_ID_COOKIE_NAME)
  } catch (error) {
    log.error('WebdriverIO RUM correlation cookie cleanup error', error)
  }
}

/**
 * Removes every RUM correlation cookie without loading its application origin.
 *
 * @param {object} browser
 * @yields {unknown} Browser command result.
 * @returns {RumGenerator}
 */
function * cleanupRumCookies (browser) {
  if (!browser.isBidi || typeof browser.storageDeleteCookies !== 'function') return

  try {
    yield browser.storageDeleteCookies({
      filter: { name: RUM_TEST_EXECUTION_ID_COOKIE_NAME },
    })
  } catch (error) {
    log.error('WebdriverIO RUM cross-origin cookie cleanup error', error)
  }
}

/**
 * Runs one RUM operation in every open browser window and restores the original window.
 *
 * @param {object} browser
 * @param {(browser: object, value?: string) => RumGenerator} operation
 * @param {string} [value]
 * @yields {unknown} Browser command result or delegated RUM operation.
 * @returns {RumGenerator}
 */
function * forEachRumWindow (browser, operation, value) {
  if (typeof browser.getWindowHandle !== 'function' ||
      typeof browser.getWindowHandles !== 'function' ||
      typeof browser.switchToWindow !== 'function') {
    yield * operation(browser, value)
    return
  }

  let currentWindowHandle
  let windowHandles
  try {
    currentWindowHandle = yield browser.getWindowHandle()
    windowHandles = yield browser.getWindowHandles()
  } catch (error) {
    log.error('WebdriverIO RUM window discovery error', error)
    yield * operation(browser, value)
    return
  }

  for (const windowHandle of windowHandles) {
    try {
      yield browser.switchToWindow(windowHandle)
    } catch (error) {
      log.error('WebdriverIO RUM window switch error', error)
      continue
    }
    yield * operation(browser, value)
  }

  const canRestoreWindow = windowHandles.includes(currentWindowHandle)
  if (windowHandles.length > 1 && canRestoreWindow) {
    try {
      yield browser.switchToWindow(currentWindowHandle)
    } catch (error) {
      log.error('WebdriverIO RUM window restore error', error)
    }
  }
}

/**
 * Cleans up every open window for one browser and restores the original window.
 *
 * @param {object} browser
 * @param {boolean} [stopShared]
 * @yields {unknown} Browser command result or delegated cleanup operation.
 * @returns {RumGenerator}
 */
function * cleanupRumBrowser (browser, stopShared = false) {
  yield * removeRumPreloadScript(browser)
  if (sharedRumBrowsers.has(browser) && !stopShared) {
    yield * forEachRumWindow(browser, deleteRumCookie)
  } else {
    yield * forEachRumWindow(browser, cleanupRumWindow)
    rumBrowsers.delete(browser)
    sharedRumBrowsers.delete(browser)
  }
  yield * cleanupRumCookies(browser)
  rumBrowserTestExecutionIds.delete(browser)
}

/**
 * Cleans up every browser prepared for RUM correlation by the current test.
 *
 * @yields {unknown} Delegated browser cleanup operation.
 * @returns {RumGenerator}
 */
function * cleanupRumBrowsers () {
  const browsers = [...rumCorrelationBrowsers]
  rumCorrelationBrowsers.clear()
  for (const browser of browsers) {
    yield * cleanupRumBrowser(browser)
  }
  return browsers
}

/**
 * Cleans up every retained RUM browser before the WebdriverIO worker exits.
 *
 * @yields {unknown} Delegated browser cleanup operation.
 * @returns {RumGenerator}
 */
function * cleanupAllRumBrowsers () {
  const browsers = [...rumBrowsers]
  rumBrowsers.clear()
  rumCorrelationBrowsers.clear()
  for (const browser of browsers) {
    yield * cleanupRumBrowser(browser, true)
  }
}

/**
 * Reapplies RUM correlation to every open browser window for a retry.
 *
 * @param {object} browser
 * @param {string} testExecutionId
 * @yields {unknown} Browser command result or delegated correlation operation.
 * @returns {RumGenerator}
 */
function * correlateRumBrowser (browser, testExecutionId) {
  rumBrowsers.add(browser)
  rumCorrelationBrowsers.add(browser)
  rumBrowserTestExecutionIds.set(browser, testExecutionId)
  yield * forEachRumWindow(browser, correlateRumWindow, testExecutionId)
}

/**
 * Reapplies RUM correlation to browsers retained across a native retry.
 *
 * @param {object[]|undefined} browsers
 * @param {string|undefined} testExecutionId
 * @yields {unknown} Delegated browser correlation operation.
 * @returns {RumGenerator}
 */
function * correlateRumBrowsers (browsers, testExecutionId) {
  if (!browsers || !testExecutionId) return

  for (const browser of browsers) {
    yield * correlateRumBrowser(browser, testExecutionId)
  }
}

/**
 * Correlates RUM browsers discovered outside the current test before its next function runs.
 *
 * @yields {unknown} Browser command result or delegated correlation operation.
 * @returns {RumGenerator}
 */
function * startRumTest () {
  for (const browser of rumBrowsers) {
    let rumState
    try {
      rumState = yield browser.execute(detectRum)
    } catch (error) {
      log.error('WebdriverIO RUM detection error', error)
      continue
    }
    if (!rumState?.isRumActive) continue

    const testExecutionId = getRumTestExecutionId(browser, true)
    if (!testExecutionId || rumBrowserTestExecutionIds.get(browser) === testExecutionId) continue

    yield * correlateRumBrowser(browser, testExecutionId)
  }
}

/**
 * Updates the active test after asynchronous RUM initialization without ending its session.
 *
 * @yields {unknown} Browser command result.
 * @returns {RumGenerator}
 */
function * detectActiveRumBrowsers () {
  for (const browser of rumCorrelationBrowsers) {
    try {
      const rumState = yield browser.execute(detectRum)
      if (rumState?.isRumActive) getRumTestExecutionId(browser, true)
    } catch (error) {
      log.error('WebdriverIO RUM detection error', error)
    }
  }
}

/**
 * Preserves the active test's RUM correlation across a native WebdriverIO retry.
 *
 * @yields {unknown} Delegated browser correlation operation.
 * @returns {RumGenerator}
 */
function * retryRumTest () {
  const browsers = [...rumCorrelationBrowsers]
  if (browsers.length === 0) return

  const testExecutionId = getRumTestExecutionId(browsers[0], true)
  if (!testExecutionId) return

  yield * correlateRumBrowsers(browsers, testExecutionId)
}

/**
 * Delays BiDi navigation until its RUM correlation preload is installed.
 *
 * @param {{rumPreloadGenerator?: () => RumGenerator}} context
 * @returns {void}
 */
function waitForRumNavigationStart (context) {
  if (!rumPageNavigateCh.hasSubscribers) return
  context.rumPreloadGenerator = preloadRumNavigation
}

/**
 * Delays URL completion until RUM detection and correlation settle.
 *
 * @param {{
 *   resolveGenerator?: (context: object) => RumGenerator,
 *   rejectGenerator?: (context: object) => RumGenerator
 * }} context
 * @returns {void}
 */
function waitForRumNavigation (context) {
  if (!rumPageNavigateCh.hasSubscribers) return
  context.resolveGenerator = handleRumNavigation
  context.rejectGenerator = handleRumNavigation
}

/**
 * Detects delayed RUM at test end and cleans it up after the user's afterEach hook.
 *
 * @param {{
 *   arguments?: unknown[],
 *   resolveGenerator?: () => RumGenerator,
 *   rejectGenerator?: () => RumGenerator
 * }} context
 * @returns {void}
 */
function waitForRumCleanup (context) {
  const type = context.arguments?.[1]
  const hookName = context.arguments?.[7]
  if (rumCorrelationBrowsers.size === 0) return

  if (type === 'Test') {
    context.resolveGenerator = detectActiveRumBrowsers
    context.rejectGenerator = detectActiveRumBrowsers
  } else if (type === 'Hook' && hookName === 'afterEach') {
    context.resolveGenerator = cleanupRumBrowsers
    context.rejectGenerator = cleanupRumBrowsers
  }
}

/**
 * Detects delayed RUM on test failures and cleans it up after a failed afterEach hook.
 *
 * @param {{arguments?: unknown[], rejectGenerator?: () => RumGenerator}} context
 * @returns {void}
 */
function waitForFailedRumCleanup (context) {
  const type = context.arguments?.[1]
  const hookName = context.arguments?.[7]
  if (rumCorrelationBrowsers.size === 0) return

  if (type === 'Test') {
    context.rejectGenerator = detectActiveRumBrowsers
  } else if (type === 'Hook' && hookName === 'afterEach') {
    context.rejectGenerator = cleanupRumBrowsers
  }
}

/**
 * @typedef {object} WebdriverioRunnerConfig
 * @property {string} framework
 * @property {string|undefined} rootDir
 * @property {typeof process.env|undefined} runnerEnv
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
 * @property {Map<string, WebdriverioSuiteResult>} reportedSuiteResults
 * @property {Map<string, WebdriverioSuiteContext>} suiteContexts
 * @property {string} testSuiteExecutionId
 * @property {boolean|undefined} hasTests
 * @property {number|undefined} exitCode
 * @property {number|undefined} retries
 */

/**
 * @typedef {object} WebdriverioSuiteContext
 * @property {object|undefined} currentStore
 * @property {Error|undefined} error
 * @property {string|undefined} status
 * @property {string} testSuiteAbsolutePath
 * @property {string} testSuiteExecutionId
 */

/**
 * @typedef {object} WebdriverioSuiteResult
 * @property {{message?: string, stack?: string}|undefined} error
 * @property {string|undefined} status
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
 * @property {Map<string, object>} attemptToFixExecutions
 * @property {number} maxActiveWorkers
 * @property {Set<string>} newTestsWithDynamicNames
 * @property {number} nextWorkerId
 * @property {Set<string>} scheduledFiles
 * @property {Map<string, object>} testManagementExecutions
 * @property {unknown} runError
 * @property {Set<WorkerRecord>} workers
 * @property {Map<object, string>} suiteStatuses
 */

/**
 * Creates the configuration consumed by WebdriverIO workers.
 *
 * @returns {object}
 */
function createWorkerConfiguration () {
  return {
    earlyFlakeDetectionFaultyThreshold: 30,
    earlyFlakeDetectionRetryPolicy: EMPTY_EFD_RETRY_POLICY,
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
    testFramework: TEST_FRAMEWORK,
    testManagementAttemptToFixRetries: 0,
    testManagementTests: {},
  }
}

/**
 * Configures a Jasmine worker and waits for its coordinator-owned optimization settings.
 *
 * @param {{_jrunner?: {env?: {addReporter?: (reporter: object) => void}}, _specs?: string[]}} adapter
 * @param {{
 *   resolveCallback?: (onDone: () => void) => void,
 *   rejectCallback?: (onDone: () => void) => void
 * }} context
 * @returns {void}
 */
function initializeJasmineWorker (adapter, context) {
  if (!isWebdriverioWorker) {
    return
  }

  const specs = adapter?._specs || []

  if (jasmineDoneCh.hasSubscribers) {
    adapter?._jrunner?.env?.addReporter?.({
      /**
       * Publishes run-level failures that are absent from suiteDone.
       *
       * @param {object} result
       * @returns {void}
       */
      jasmineDone (result) {
        jasmineDoneCh.publish({ result })
      },
    })
  }

  /**
   * Waits until the coordinator has started this worker's parent spans.
   *
   * @param {() => void} onDone
   * @returns {void}
   */
  const waitForCoordinator = onDone => {
    const requestId = `${process.pid}-${++jasmineWorkerRequestId}`
    let finished = false

    /**
     * Releases Jasmine initialization exactly once.
     *
     * @param {object} [configuration]
     * @returns {void}
     */
    function finish (configuration = createWorkerConfiguration()) {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timeout)
      process.off('message', onMessage)
      process.off('disconnect', finish)
      workerConfigurationCh.publish({
        libraryConfig: configuration,
        repositoryRoot: configuration.repositoryRoot,
        specs,
        testFramework: TEST_FRAMEWORK,
        testFrameworkAdapter: JASMINE_FRAMEWORK_ADAPTER,
      })
      onDone()
    }

    /**
     * Receives coordinator readiness for this worker.
     *
     * @param {object} message
     * @returns {void}
     */
    function onMessage (message) {
      if (message?.name === WORKER_READY_RESPONSE && message.content?.requestId === requestId) {
        finish(message.content.configuration)
      }
    }

    const timeout = setTimeout(finish, 30_000)
    process.on('message', onMessage)
    process.once('disconnect', finish)
    sendWebdriverioWorkerMessage({
      origin: 'datadog',
      name: WORKER_READY,
      content: {
        requestId,
        testFrameworkAdapter: JASMINE_FRAMEWORK_ADAPTER,
      },
    }, error => {
      if (error) {
        log.error('WebdriverIO Test Optimization IPC error', error)
      }
      finish()
    })
  }

  context.resolveCallback = waitForCoordinator
  context.rejectCallback = waitForCoordinator
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
    attemptToFixExecutions: new Map(),
    maxActiveWorkers: 0,
    newTestsWithDynamicNames: new Set(),
    nextWorkerId: 0,
    scheduledFiles: new Set(),
    testManagementExecutions: new Map(),
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
 * Adds resolved WebdriverIO spec files to the coordinator's complete schedule.
 *
 * @param {CoordinatorState} state
 * @param {string[]} files
 * @returns {void}
 */
function addScheduledFiles (state, files) {
  for (const file of files) {
    state.scheduledFiles.add(normalizeFile(file))
  }
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
 * Starts the single test session owned by the WebdriverIO launcher.
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
 * @returns {void}
 */
function completeCoordinatorInitialization (state) {
  if (state.initialized) {
    return
  }

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
 * Runs one coordinator-owned feature request.
 *
 * @param {CoordinatorState} state
 * @param {import('node:diagnostics_channel').Channel} requestChannel
 * @param {(response: object) => void} onDone
 * @returns {void}
 */
function requestCoordinatorData (state, requestChannel, onDone) {
  if (!requestChannel.hasSubscribers) {
    onDone({ err: new Error('Test optimization was not initialized correctly') })
    return
  }

  try {
    requestChannel.runStores({
      onDone: response => state.asyncResource.runInAsyncScope(onDone, undefined, response),
    }, () => {})
  } catch (error) {
    log.error('WebdriverIO Test Optimization feature request error', error)
    onDone({ err: error })
  }
}

/**
 * Maps backend framework data to the Mocha adapter's internal framework key.
 *
 * @param {object|undefined} frameworkData
 * @returns {object|undefined}
 */
function getMochaFrameworkData (frameworkData) {
  return frameworkData?.[TEST_FRAMEWORK] ?? frameworkData?.mocha
}

/**
 * Applies the worker configuration for an EFD session with faulty known-tests data.
 *
 * @param {object} configuration
 * @returns {void}
 */
function setEarlyFlakeDetectionFaulty (configuration) {
  configuration.isEarlyFlakeDetectionEnabled = false
  configuration.isEarlyFlakeDetectionFaulty = true
  configuration.isKnownTestsEnabled = false
}

/**
 * Applies settings and requests the enabled non-TIA datasets once for the whole run.
 *
 * @param {CoordinatorState} state
 * @param {object|undefined} response
 * @returns {void}
 */
function configureCoordinator (state, response) {
  const { configuration } = state
  const {
    err,
    isTestDynamicInstrumentationEnabled,
    libraryConfig,
    repositoryRoot,
  } = response || {}

  configuration.repositoryRoot = repositoryRoot
  if (err || !libraryConfig) {
    completeCoordinatorInitialization(state)
    return
  }

  configuration.earlyFlakeDetectionFaultyThreshold = libraryConfig.earlyFlakeDetectionFaultyThreshold
  configuration.earlyFlakeDetectionRetryPolicy = libraryConfig.earlyFlakeDetectionRetryPolicy ?? EMPTY_EFD_RETRY_POLICY
  configuration.flakyTestRetriesCount = libraryConfig.flakyTestRetriesCount
  configuration.isDiEnabled = libraryConfig.isDiEnabled
  configuration.isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
  configuration.isFlakyTestRetriesEnabled = libraryConfig.isFlakyTestRetriesEnabled
  configuration.isImpactedTestsEnabled = libraryConfig.isImpactedTestsEnabled
  configuration.isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
  configuration.isTestDynamicInstrumentationEnabled = isTestDynamicInstrumentationEnabled
  configuration.isTestManagementTestsEnabled = libraryConfig.isTestManagementEnabled
  configuration.testManagementAttemptToFixRetries = libraryConfig.testManagementAttemptToFixRetries

  let pendingRequests = 1

  /**
   * Completes initialization after all enabled requests settle.
   *
   * @returns {void}
   */
  function finishRequest () {
    pendingRequests--
    if (pendingRequests === 0) {
      completeCoordinatorInitialization(state)
    }
  }

  if (configuration.isKnownTestsEnabled) {
    pendingRequests++
    requestCoordinatorData(state, knownTestsCh, ({ err, knownTests } = {}) => {
      const mochaKnownTests = getMochaFrameworkData(knownTests)
      if (err) {
        configuration.isEarlyFlakeDetectionEnabled = false
        configuration.isKnownTestsEnabled = false
      } else if (mochaKnownTests === undefined) {
        setEarlyFlakeDetectionFaulty(configuration)
      } else {
        configuration.knownTests = { mocha: mochaKnownTests }
      }
      finishRequest()
    })
  }

  if (configuration.isTestManagementTestsEnabled) {
    pendingRequests++
    requestCoordinatorData(state, testManagementTestsCh, ({ err, testManagementTests } = {}) => {
      if (err) {
        configuration.isTestManagementTestsEnabled = false
        configuration.testManagementAttemptToFixRetries = 0
      } else {
        const mochaTestManagementTests = getMochaFrameworkData(testManagementTests) || { suites: {} }
        configuration.testManagementTests = { mocha: mochaTestManagementTests }
      }
      finishRequest()
    })
  }

  if (configuration.isImpactedTestsEnabled) {
    pendingRequests++
    requestCoordinatorData(state, modifiedFilesCh, ({ err, modifiedFiles } = {}) => {
      if (err) {
        configuration.isImpactedTestsEnabled = false
      } else {
        configuration.modifiedFiles = modifiedFiles
      }
      finishRequest()
    })
  }

  finishRequest()
}

/**
 * Requests settings once so the launcher owns initialization for every worker.
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
      disableTestImpactAnalysis: true,
      frameworkVersion: state.frameworkVersion,
      isParallel: state.maxActiveWorkers > 1,
      testFramework: TEST_FRAMEWORK,
      onDone: response => state.asyncResource.runInAsyncScope(
        configureCoordinator,
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
 * Starts suites for one worker.
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

    const reportedResult = workerRecord.reportedSuiteResults.get(file)
    const suiteContext = {
      error: getWebdriverioSuiteError(reportedResult?.error),
      status: reportedResult?.status,
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
  if (suiteContext.error) {
    testSuiteErrorCh.runStores(suiteContext, () => {})
  }
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
 * Handles a worker request for its execution configuration.
 *
 * @param {CoordinatorState} state
 * @param {WorkerRecord} workerRecord
 * @param {object} message
 * @returns {void}
 */
function handleConfigurationRequest (state, workerRecord, message) {
  const { files = [], requestId } = message.content || {}

  initializeCoordinator(state, (configuration) => {
    updateEarlyFlakeDetectionFaultyState(state, files)
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
 * Disables EFD when the accumulated WebdriverIO run exceeds its new-suite threshold.
 *
 * @param {CoordinatorState} state
 * @param {string[]} files
 * @returns {void}
 */
function updateEarlyFlakeDetectionFaultyState (state, files) {
  const { configuration } = state
  if (!configuration.isKnownTestsEnabled) {
    return
  }

  addScheduledFiles(state, files)
  const scheduledSuites = []
  for (const file of state.scheduledFiles) {
    scheduledSuites.push(getTestSuitePath(file, process.cwd()))
  }

  const isFaulty = getIsFaultyEarlyFlakeDetection(
    scheduledSuites,
    configuration.knownTests?.mocha || {},
    configuration.earlyFlakeDetectionFaultyThreshold
  )
  if (isFaulty) {
    setEarlyFlakeDetectionFaulty(configuration)
  }
}

/**
 * Reconstructs an Error received from a WebdriverIO worker.
 *
 * @param {{message?: string, stack?: string}|undefined} error
 * @returns {Error|undefined}
 */
function getWebdriverioSuiteError (error) {
  if (!error?.message) {
    return
  }

  const suiteError = new Error(error.message)
  if (error.stack) {
    suiteError.stack = error.stack
  }
  return suiteError
}

/**
 * Handles suite results reported by a WebdriverIO worker.
 *
 * @param {WorkerRecord} workerRecord
 * @param {object} message
 * @returns {void}
 */
function handleSuiteResults (workerRecord, message) {
  const { results = [] } = message.content || {}
  for (const { error, file, status } of results) {
    const normalizedFile = normalizeFile(file)
    workerRecord.reportedSuiteResults.set(normalizedFile, { error, status })
    const suiteContext = workerRecord.suiteContexts.get(normalizedFile)
    if (suiteContext) {
      suiteContext.error = getWebdriverioSuiteError(error)
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
  if (message?.origin === WEBDRIVERIO_WORKER_ORIGIN && message.name === WEBDRIVERIO_WORKER_EVENT) {
    message = message.args
  }

  if (Array.isArray(message)) {
    const [messageCode, payload] = message
    if (messageCode === MOCHA_WORKER_TRACE_PAYLOAD_CODE) {
      collectTestOptimizationSummariesFromTraces(payload, {
        attemptToFixExecutions: state.attemptToFixExecutions,
        newTestsWithDynamicNames: state.newTestsWithDynamicNames,
        testManagementExecutions: state.testManagementExecutions,
      })
      workerReportTraceCh.publish({
        traces: payload,
        [TEST_SUITE_EXECUTION_ID]: workerRecord.testSuiteExecutionId,
      })
    } else if (messageCode === MOCHA_WORKER_LOGS_PAYLOAD_CODE) {
      workerReportLogsCh.publish(payload)
    } else if (messageCode === MOCHA_WORKER_TELEMETRY_PAYLOAD_CODE) {
      workerReportTelemetryCh.publish(payload)
    }
    return
  }

  if (!message || typeof message !== 'object') {
    return
  }

  if (message.name === WORKER_READY) {
    initializeCoordinator(state, configuration => {
      if (state.testFrameworkAdapter === JASMINE_FRAMEWORK_ADAPTER) {
        updateEarlyFlakeDetectionFaultyState(state, workerRecord.specs)
        startWorkerSuites(workerRecord, workerRecord.specs)
      }
      if (message.content?.requestId) {
        sendWorkerMessage(workerRecord, {
          origin: 'datadog',
          name: WORKER_READY_RESPONSE,
          content: { configuration, requestId: message.content.requestId },
        })
      }
    })
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
    reportedSuiteResults: new Map(),
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
 * Finishes the single WebdriverIO-owned test session.
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
    logTestOptimizationSummary({
      attemptToFixExecutions: state.attemptToFixExecutions,
      newTestsWithDynamicNames: state.newTestsWithDynamicNames,
      testManagementExecutions: state.testManagementExecutions,
    })
    onDone()
    return
  }

  testSessionFinishCh.publish({
    status: error ? 'fail' : getSessionStatus(state),
    error,
    isEarlyFlakeDetectionEnabled: state.configuration.isEarlyFlakeDetectionEnabled,
    isEarlyFlakeDetectionFaulty: state.configuration.isEarlyFlakeDetectionFaulty,
    isParallel: state.maxActiveWorkers > 1,
    isSuitesSkipped: false,
    isTestManagementEnabled: state.configuration.isTestManagementTestsEnabled,
    onDone,
  })
  logTestOptimizationSummary({
    attemptToFixExecutions: state.attemptToFixExecutions,
    newTestsWithDynamicNames: state.newTestsWithDynamicNames,
    testManagementExecutions: state.testManagementExecutions,
  })
}

/**
 * Delays WebdriverIO worker exit until pending log-submission requests settle.
 *
 * @param {{
 *   resolveCallback?: (onDone: () => void) => void,
 *   rejectCallback?: (onDone: () => void) => void
 * }} context
 * @returns {void}
 */
function waitForLogSubmissionAtWorkerExit (context) {
  if (rumBrowsers.size > 0) {
    context.resolveGenerator = cleanupAllRumBrowsers
    context.rejectGenerator = cleanupAllRumBrowsers
  }
  if (!isWebdriverioWorker || !logSubmissionFlushCh.hasSubscribers) return

  const waitForLogs = onDone => publishWithCompletion(logSubmissionFlushCh, {}, onDone)
  context.resolveCallback = waitForLogs
  context.rejectCallback = waitForLogs
}

baseReporterWaitForSyncCh.asyncEnd.subscribe(
  /** @type {import('node:diagnostics_channel').ChannelListener} */ (waitForLogSubmissionAtWorkerExit)
)

urlCh.start.subscribe(
  /** @type {import('node:diagnostics_channel').ChannelListener} */ (waitForRumNavigationStart)
)

urlCh.asyncEnd.subscribe(
  /** @type {import('node:diagnostics_channel').ChannelListener} */ (waitForRumNavigation)
)

testFrameworkFnWrapperCh.asyncEnd.subscribe(
  /** @type {import('node:diagnostics_channel').ChannelListener} */ (waitForRumCleanup)
)

testFrameworkFnWrapperCh.error.subscribe(
  /** @type {import('node:diagnostics_channel').ChannelListener} */ (waitForFailedRumCleanup)
)

// dc-polyfill supports partial tracing-channel subscribers, unlike the Node.js type definition.
// @ts-expect-error
executeAsyncCh.subscribe({
  start (context) {
    context.rumStartGenerator = startRumTest
    context.rumCleanupGenerator = cleanupRumBrowsers
    context.rumCorrelationGenerator = correlateRumBrowsers
    context.retryGenerator ??= retryRumTest
  },
})

// @ts-expect-error See the partial tracing-channel subscriber above.
jasmineAdapterInitCh.subscribe({
  asyncEnd (context) {
    initializeJasmineWorker(context.result || context.self, context)
  },
})

// dc-polyfill supports partial tracing-channel subscribers, unlike the Node.js type definition.
// @ts-expect-error
launcherStartInstanceCh.subscribe({
  start (context) {
    const localRunner = context.self?.runner
    const runnerConfiguration = localRunner && getRunnerConfiguration(localRunner)
    if (!testFinishCh.hasSubscribers || !SUPPORTED_FRAMEWORK_ADAPTERS.has(runnerConfiguration?.framework)) {
      return
    }

    const state = getCoordinatorState(localRunner)
    addScheduledFiles(state, context.arguments?.[0] || [])
    if (context.self._schedule) {
      for (const schedule of context.self._schedule) {
        if (schedule.specs) {
          for (const { files } of schedule.specs) {
            addScheduledFiles(state, files)
          }
        }
      }
    }
  },
})

// dc-polyfill supports partial tracing-channel subscribers, unlike the Node.js type definition.
// @ts-expect-error
localRunnerRunCh.subscribe({
  start (context) {
    const runnerConfiguration = getRunnerConfiguration(context.self)
    if (!testFinishCh.hasSubscribers || !SUPPORTED_FRAMEWORK_ADAPTERS.has(runnerConfiguration?.framework)) {
      return
    }

    const state = getCoordinatorState(context.self)
    const workerOptions = context.arguments?.[0]
    addScheduledFiles(state, workerOptions?.specs || [])
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
