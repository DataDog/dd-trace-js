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
  SCREENSHOT_UPLOAD,
  SCREENSHOT_UPLOAD_RESPONSE,
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
const screenshotCapabilitiesCh = channel('ci:webdriverio:screenshot:capabilities')
const screenshotUploadCh = channel('ci:webdriverio:screenshot:upload')
const testManagementTestsCh = channel('ci:mocha:test-management-tests')
const workerConfigurationCh = channel('ci:mocha:worker:configuration')
const workerReportLogsCh = channel('ci:mocha:worker-report:logs')
const workerReportTelemetryCh = channel('ci:mocha:worker-report:telemetry')
const workerReportTraceCh = channel('ci:mocha:worker-report:trace')

const jasmineAdapterInitCh = tracingChannel('orchestrion:@wdio/jasmine-framework:JasmineAdapter_init')
const baseReporterWaitForSyncCh = tracingChannel('orchestrion:@wdio/runner:BaseReporter_waitForSync')
const runnerRunCh = tracingChannel('orchestrion:@wdio/runner:Runner_run')
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
const SET_RUM_COOKIE_SCRIPT = 'cookie => { globalThis.document.cookie = cookie }'
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
const rumRunnerBrowsers = new WeakSet()
const rumBrowserPreloadScripts = new WeakMap()
const rumBrowserTestExecutionIds = new WeakMap()
let isRumCleanupPending = false

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
 * Returns whether this browser can preload and clean correlation across every browsing context.
 *
 * @param {object} browser
 * @returns {boolean}
 */
function canCorrelateRumBrowser (browser) {
  return browser?.isBidi &&
    typeof browser.scriptAddPreloadScript === 'function' &&
    typeof browser.scriptRemovePreloadScript === 'function' &&
    typeof browser.storageDeleteCookies === 'function'
}

/**
 * Returns whether RUM is inactive because its configured sampling rate is below 100%.
 *
 * @param {{isRumActive: boolean, isRumInstrumented: boolean, rumSamplingRate: number|null}} rumState
 * @returns {boolean}
 */
function isRumSampledOut (rumState) {
  return rumState.isRumInstrumented && !rumState.isRumActive &&
    rumState.rumSamplingRate !== null && rumState.rumSamplingRate < 100
}

/**
 * Installs RUM correlation on every subsequent document in the BiDi session.
 *
 * @param {object} browser
 * @param {string} testExecutionId
 * @returns {Promise<void>}
 */
async function installRumPreloadScript (browser, testExecutionId) {
  if (!browser.isBidi ||
      typeof browser.scriptAddPreloadScript !== 'function') return

  try {
    const preloadScript = rumBrowserPreloadScripts.get(browser)
    if (preloadScript && preloadScript.sessionId === browser.sessionId &&
        preloadScript.testExecutionId === testExecutionId) return
    if (preloadScript && preloadScript.sessionId === browser.sessionId) {
      await removeRumPreloadScript(browser)
    } else {
      rumBrowserPreloadScripts.delete(browser)
    }

    const cookie = `${RUM_TEST_EXECUTION_ID_COOKIE_NAME}=${testExecutionId}; path=/`
    const { script } = await browser.scriptAddPreloadScript({
      arguments: [{ type: 'string', value: cookie }],
      functionDeclaration: SET_RUM_COOKIE_SCRIPT,
    })
    rumBrowserPreloadScripts.set(browser, { script, sessionId: browser.sessionId, testExecutionId })
  } catch (error) {
    log.error('WebdriverIO RUM correlation preload error', error)
  }
}

/**
 * Removes a browser-wide RUM correlation preload.
 *
 * @param {object} browser
 * @returns {Promise<void>}
 */
async function removeRumPreloadScript (browser) {
  const preloadScript = rumBrowserPreloadScripts.get(browser)
  rumBrowserPreloadScripts.delete(browser)
  if (!preloadScript || preloadScript.sessionId !== browser.sessionId ||
      typeof browser.scriptRemovePreloadScript !== 'function') return

  try {
    await browser.scriptRemovePreloadScript({ script: preloadScript.script })
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
    isTestOptimizationRunner: isWebdriverioWorker,
    testExecutionId: undefined,
  }
  try {
    rumPageNavigateCh.publish(correlationContext)
  } catch (error) {
    log.error('WebdriverIO RUM correlation channel error', error)
  }
  if (correlationContext.isTestOptimizationRunner || correlationContext.testExecutionId) {
    rumRunnerBrowsers.add(browser)
  }
  return correlationContext.testExecutionId
}

/**
 * Installs RUM correlation before a BiDi navigation starts.
 *
 * @this {object}
 * @returns {Promise<void>}
 */
async function preloadRumNavigation () {
  try {
    const browser = this
    if (!canCorrelateRumBrowser(browser) || !browser.isBidi ||
        typeof browser.scriptAddPreloadScript !== 'function') return

    const testExecutionId = getRumTestExecutionId(browser)
    if (!testExecutionId) return

    rumBrowsers.add(browser)
    rumCorrelationBrowsers.add(browser)
    rumBrowserTestExecutionIds.set(browser, testExecutionId)
    await installRumPreloadScript(browser, testExecutionId)
  } catch (error) {
    log.error('WebdriverIO RUM correlation preload error', error)
  }
}

/**
 * Correlates the current browser window with one test execution.
 *
 * @param {object} browser
 * @param {string} testExecutionId
 * @returns {Promise<void>}
 */
async function correlateRumWindow (browser, testExecutionId) {
  if (!canCorrelateRumBrowser(browser)) return

  try {
    await browser.setCookies({
      name: RUM_TEST_EXECUTION_ID_COOKIE_NAME,
      value: testExecutionId,
    })
  } catch (error) {
    log.error('WebdriverIO RUM correlation cookie error', error)
  }
  await installRumPreloadScript(browser, testExecutionId)
}

/**
 * Detects RUM after a browser navigation and correlates it with the active test.
 *
 * @param {{self?: object}} context
 * @returns {Promise<void>}
 */
async function handleRumNavigation (context) {
  const browser = context.self
  try {
    if (!browser || typeof browser.execute !== 'function') return

    let rumState
    try {
      rumState = await browser.execute(detectRum)
    } catch (error) {
      log.error('WebdriverIO RUM detection error', error)
      return
    }

    if (!rumState) return

    const { isRumActive } = rumState
    const sampledOut = isRumSampledOut(rumState)
    if (sampledOut) {
      log.debug("RUM was detected on the page, but it isn't active because the sampling rate is below 100%")
    }
    const canCorrelateRum = canCorrelateRumBrowser(browser)
    const testExecutionId = getRumTestExecutionId(browser, canCorrelateRum ? isRumActive : false)
    if (!canCorrelateRum || !rumRunnerBrowsers.has(browser) || sampledOut) return

    rumBrowsers.add(browser)
    if (!testExecutionId) {
      return
    }
    if (!isRumActive && browser.isBidi) return

    await correlateRumBrowser(browser, testExecutionId)
  } catch (error) {
    log.error('WebdriverIO RUM correlation error', error)
  }
}

/**
 * Stops RUM in the current window.
 *
 * @param {object} browser
 * @returns {Promise<boolean>}
 */
async function stopRumWindow (browser) {
  let isRumActive
  try {
    isRumActive = await browser.execute(stopRumSession)
  } catch (error) {
    log.error('WebdriverIO RUM cleanup error', error)
  }

  if (isRumActive) {
    getRumTestExecutionId(browser, true)
  }
  return !!isRumActive
}

/**
 * Removes the RUM correlation cookie from the current window.
 *
 * @param {object} browser
 * @returns {Promise<void>}
 */
async function deleteRumCookie (browser) {
  try {
    await browser.deleteCookies(RUM_TEST_EXECUTION_ID_COOKIE_NAME)
  } catch (error) {
    log.error('WebdriverIO RUM correlation cookie cleanup error', error)
  }
}

/**
 * Removes every RUM correlation cookie without loading its application origin.
 *
 * @param {object} browser
 * @returns {Promise<void>}
 */
async function cleanupRumCookies (browser) {
  if (!browser.isBidi || typeof browser.storageDeleteCookies !== 'function') return

  try {
    await browser.storageDeleteCookies({
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
 * @template T
 * @param {(browser: object, value?: T) => Promise<void>} operation
 * @param {T} [value]
 * @returns {Promise<void>}
 */
async function forEachRumWindow (browser, operation, value) {
  if (typeof browser.getWindowHandle !== 'function' ||
      typeof browser.getWindowHandles !== 'function' ||
      typeof browser.switchToWindow !== 'function') {
    await operation(browser, value)
    return
  }

  let currentWindowHandle
  let windowHandles
  try {
    currentWindowHandle = await browser.getWindowHandle()
    windowHandles = await browser.getWindowHandles()
  } catch (error) {
    log.error('WebdriverIO RUM window discovery error', error)
    await operation(browser, value)
    return
  }

  for (const windowHandle of windowHandles) {
    try {
      // WebDriver window commands must run in order because each one changes the active window.
      // eslint-disable-next-line no-await-in-loop
      await browser.switchToWindow(windowHandle)
    } catch (error) {
      log.error('WebdriverIO RUM window switch error', error)
      continue
    }
    // eslint-disable-next-line no-await-in-loop
    await operation(browser, value)
  }

  const canRestoreWindow = windowHandles.includes(currentWindowHandle)
  if (windowHandles.length > 1 && canRestoreWindow) {
    try {
      await browser.switchToWindow(currentWindowHandle)
    } catch (error) {
      log.error('WebdriverIO RUM window restore error', error)
    }
  }
}

/**
 * Removes the current test's RUM correlation while keeping reusable sessions active.
 * The session is stopped only when WebdriverIO is about to close the browser.
 *
 * @param {object} browser
 * @param {boolean} [stopSession]
 * @returns {Promise<void>}
 */
async function cleanupRumBrowser (browser, stopSession = false) {
  await removeRumPreloadScript(browser)
  if (stopSession) {
    let isRumActive = false
    await forEachRumWindow(browser, async (browser) => {
      if (await stopRumWindow(browser)) isRumActive = true
    })
    if (isRumActive) {
      await new Promise(resolve => realSetTimeout(resolve, RUM_FLUSH_WAIT_TIME))
    }
    rumBrowsers.delete(browser)
  } else {
    await forEachRumWindow(browser, deleteRumCookie)
  }
  await cleanupRumCookies(browser)
  rumBrowserTestExecutionIds.delete(browser)
}

/**
 * Removes the current test's RUM correlation from every prepared browser.
 *
 * @returns {Promise<object[]>}
 */
async function cleanupRumBrowsers () {
  isRumCleanupPending = false
  const browsers = [...rumCorrelationBrowsers]
  rumCorrelationBrowsers.clear()
  for (const browser of browsers) {
    // Cleanup is intentionally sequential to avoid overlapping WebDriver commands.
    // eslint-disable-next-line no-await-in-loop
    await cleanupRumBrowser(browser)
  }
  return browsers
}

/**
 * Cleans up every retained RUM browser before the WebdriverIO worker exits.
 *
 * @returns {Promise<void>}
 */
async function cleanupAllRumBrowsers () {
  isRumCleanupPending = false
  const browsers = [...rumBrowsers]
  rumBrowsers.clear()
  rumCorrelationBrowsers.clear()
  for (const browser of browsers) {
    // Cleanup is intentionally sequential to avoid overlapping WebDriver commands.
    // eslint-disable-next-line no-await-in-loop
    await cleanupRumBrowser(browser, true)
  }
}

/**
 * Reapplies RUM correlation to every open browser window for a retry.
 *
 * @param {object} browser
 * @param {string} testExecutionId
 * @returns {Promise<void>}
 */
async function correlateRumBrowser (browser, testExecutionId) {
  if (!canCorrelateRumBrowser(browser)) return

  rumBrowsers.add(browser)
  rumCorrelationBrowsers.add(browser)
  rumBrowserTestExecutionIds.set(browser, testExecutionId)
  await forEachRumWindow(browser, correlateRumWindow, testExecutionId)
}

/**
 * Reapplies RUM correlation to browsers retained across a native retry.
 *
 * @param {object[]|undefined} browsers
 * @param {string|undefined} testExecutionId
 * @returns {Promise<void>}
 */
async function correlateRumBrowsers (browsers, testExecutionId) {
  if (!browsers || !testExecutionId) return

  for (const browser of browsers) {
    // WebDriver commands are intentionally sequential for each browser.
    // eslint-disable-next-line no-await-in-loop
    await correlateRumBrowser(browser, testExecutionId)
  }
}

/**
 * Correlates RUM browsers discovered outside the current test before its next function runs.
 *
 * @returns {Promise<void>}
 */
async function startRumTest () {
  for (const browser of rumBrowsers) {
    let rumState
    try {
      // WebDriver commands are intentionally sequential for each browser.
      // eslint-disable-next-line no-await-in-loop
      rumState = await browser.execute(detectRum)
    } catch (error) {
      log.error('WebdriverIO RUM detection error', error)
      continue
    }
    if (!rumState || isRumSampledOut(rumState)) continue

    const testExecutionId = getRumTestExecutionId(browser, rumState.isRumActive || undefined)
    if (!testExecutionId || rumBrowserTestExecutionIds.get(browser) === testExecutionId) continue

    // eslint-disable-next-line no-await-in-loop
    await correlateRumBrowser(browser, testExecutionId)
  }
}

/**
 * Detects active RUM browsers and optionally updates the active test without ending their sessions.
 *
 * @param {boolean} [updateTest]
 * @returns {Promise<boolean>}
 */
async function detectActiveRumBrowsers (updateTest = true) {
  let isRumActive = false
  for (const browser of rumCorrelationBrowsers) {
    try {
      // WebDriver commands are intentionally sequential for each browser.
      // eslint-disable-next-line no-await-in-loop
      const rumState = await browser.execute(detectRum)
      if (rumState?.isRumActive) {
        isRumActive = true
        if (updateTest) getRumTestExecutionId(browser, true)
      }
    } catch (error) {
      log.error('WebdriverIO RUM detection error', error)
    }
  }
  return isRumActive
}

/**
 * Preserves the active test's RUM correlation across a native WebdriverIO retry.
 *
 * @returns {Promise<void>}
 */
async function retryRumTest () {
  const browsers = [...rumCorrelationBrowsers]
  if (browsers.length === 0) return

  const isRumActive = await detectActiveRumBrowsers(false)
  const testExecutionId = getRumTestExecutionId(browsers[0], isRumActive)
  if (!testExecutionId) return

  await correlateRumBrowsers(browsers, testExecutionId)
}

/**
 * Reapplies RUM correlation for a native Jasmine retry and reports whether RUM is active.
 *
 * @param {string|undefined} testExecutionId
 * @returns {Promise<{
 *   browserName: string|undefined,
 *   browserVersion: string|undefined,
 *   isRumActive: boolean
 * }>}
 */
async function retryRumBrowsers (testExecutionId) {
  const browsers = [...rumCorrelationBrowsers]
  const isRumActive = await detectActiveRumBrowsers(false)
  await correlateRumBrowsers(browsers, testExecutionId)

  const browser = browsers[0]
  return {
    browserName: browser?.capabilities?.browserName,
    browserVersion: browser?.capabilities?.browserVersion,
    isRumActive,
  }
}

/**
 * Delays BiDi navigation until its RUM correlation preload is installed.
 *
 * @param {{rumPreloadCallback?: () => Promise<void>}} context
 * @returns {void}
 */
function waitForRumNavigationStart (context) {
  if (!rumPageNavigateCh.hasSubscribers) return
  context.rumPreloadCallback = preloadRumNavigation
}

/**
 * Makes a promise-returning RUM operation compatible with the rewriter's completion callbacks.
 *
 * @param {{
 *   resolveCallback?: (onDone: () => void) => void,
 *   rejectCallback?: (onDone: () => void) => void
 * }} context
 * @param {() => Promise<unknown>} operation
 * @param {boolean} [waitForResolve]
 * @returns {void}
 */
function setRumWaitCallbacks (context, operation, waitForResolve = true) {
  const waitForOperation = onDone => operation().then(onDone, onDone)
  if (waitForResolve) context.resolveCallback = waitForOperation
  context.rejectCallback = waitForOperation
}

/**
 * Delays URL completion until RUM detection and correlation settle.
 *
 * @param {object} context
 * @returns {void}
 */
function waitForRumNavigation (context) {
  if (!rumPageNavigateCh.hasSubscribers) return
  setRumWaitCallbacks(context, () => handleRumNavigation(context))
}

/**
 * Detects delayed RUM at test and afterEach completion.
 * Correlation remains active until every afterEach hook has run.
 *
 * @param {{arguments?: unknown[]}} context
 * @returns {void}
 */
function waitForRumCleanup (context) {
  const type = context.arguments?.[1]
  const hookName = context.arguments?.[7]
  if (rumCorrelationBrowsers.size === 0) return

  if (type === 'Test') {
    isRumCleanupPending = true
    setRumWaitCallbacks(context, detectActiveRumBrowsers)
  } else if (type === 'Hook' && hookName === 'afterEach') {
    setRumWaitCallbacks(context, detectActiveRumBrowsers)
  }
}

/**
 * Detects delayed RUM after test or afterEach failures.
 * Correlation remains active until every afterEach hook has run.
 *
 * @param {{arguments?: unknown[]}} context
 * @returns {void}
 */
function waitForFailedRumCleanup (context) {
  const type = context.arguments?.[1]
  const hookName = context.arguments?.[7]
  if (rumCorrelationBrowsers.size === 0) return

  if (type === 'Test') {
    isRumCleanupPending = true
    setRumWaitCallbacks(context, detectActiveRumBrowsers, false)
  } else if (type === 'Hook' && hookName === 'afterEach') {
    setRumWaitCallbacks(context, detectActiveRumBrowsers, false)
  } else {
    isRumCleanupPending = true
  }
}

/**
 * Cleans a completed test's RUM state before the next non-afterEach wrapper.
 *
 * @param {{arguments?: unknown[], rumCleanupCallback?: () => Promise<object[]>}} context
 * @returns {void}
 */
function waitForPendingRumCleanup (context) {
  const type = context.arguments?.[1]
  const hookName = context.arguments?.[7]
  if (!isRumCleanupPending || (type === 'Hook' && hookName === 'afterEach')) return

  context.rumCleanupCallback = cleanupRumBrowsers
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
    isTestFailureScreenshotsEnabled: false,
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

  const screenshotCapabilities = {}
  screenshotCapabilitiesCh.publish(screenshotCapabilities)
  configuration.isTestFailureScreenshotsEnabled = screenshotCapabilities.enabled === true

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
  if (message.name === SCREENSHOT_UPLOAD) {
    const { requestId, ...content } = message.content || {}
    const respond = (error) => sendWorkerMessage(workerRecord, {
      origin: 'datadog',
      name: SCREENSHOT_UPLOAD_RESPONSE,
      content: {
        error: error?.message,
        requestId,
      },
    })
    if (!requestId || !screenshotUploadCh.hasSubscribers) {
      respond(new Error('WebdriverIO screenshot upload is not available'))
    } else {
      try {
        screenshotUploadCh.publish({ ...content, onDone: respond })
      } catch (error) {
        log.error('WebdriverIO screenshot upload error: %s', error?.message || String(error))
        respond(error)
      }
    }
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
  const shouldCleanRum = rumBrowsers.size > 0
  const shouldFlushLogs = isWebdriverioWorker && logSubmissionFlushCh.hasSubscribers
  if (!shouldCleanRum && !shouldFlushLogs) return

  const waitForExit = onDone => {
    const finish = () => shouldFlushLogs
      ? publishWithCompletion(logSubmissionFlushCh, {}, onDone)
      : onDone()
    if (shouldCleanRum) {
      cleanupAllRumBrowsers().then(finish, finish)
    } else {
      finish()
    }
  }
  context.resolveCallback = waitForExit
  context.rejectCallback = waitForExit
}

/**
 * Cleans retained RUM browsers before WebdriverIO deletes the worker session.
 *
 * @param {{rumCleanupCallback?: () => Promise<void>}} context
 * @returns {void}
 */
function waitForRumCleanupBeforeSessionEnd (context) {
  context.rumCleanupCallback = cleanupAllRumBrowsers
}

baseReporterWaitForSyncCh.asyncEnd.subscribe(
  /** @type {import('node:diagnostics_channel').ChannelListener} */ (waitForLogSubmissionAtWorkerExit)
)

runnerRunCh.start.subscribe(
  /** @type {import('node:diagnostics_channel').ChannelListener} */ (waitForRumCleanupBeforeSessionEnd)
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

testFrameworkFnWrapperCh.start.subscribe(
  /** @type {import('node:diagnostics_channel').ChannelListener} */ (waitForPendingRumCleanup)
)

testFrameworkFnWrapperCh.error.subscribe(
  /** @type {import('node:diagnostics_channel').ChannelListener} */ (waitForFailedRumCleanup)
)

// dc-polyfill supports partial tracing-channel subscribers, unlike the Node.js type definition.
// @ts-expect-error
executeAsyncCh.subscribe({
  start (context) {
    context.rumStartCallback = startRumTest
    context.rumCleanupCallback = cleanupRumBrowsers
    context.rumCorrelationCallback = correlateRumBrowsers
    context.rumRetryCallback = retryRumBrowsers
    context.retryCallback ??= retryRumTest
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
