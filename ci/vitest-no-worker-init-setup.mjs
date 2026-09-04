import { afterEach, beforeAll, beforeEach, inject } from 'vitest'

// Instrumentation-less setup for DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT.
// It applies Test Optimization execution changes without initializing dd-trace and also supports Browser Mode.
const VITEST_NO_WORKER_INIT_ACTIVE_ENV = 'DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE'
const SERIALIZED_CONTEXT_PREFIX = '\u0000dd-vitest-context:'
const providedContext = getProvidedContext()
const isNoWorkerInitActive = providedContext.isActive ?? getIsNoWorkerInitActive()
const attemptToFixTests = providedContext.attemptToFixTests || {}
const attemptToFixRetries = providedContext.attemptToFixRetries || 0
const disabledTests = providedContext.disabledTests || {}
const efdSuiteAdmissionBrowserCommand = providedContext.efdSuiteAdmissionBrowserCommand
const earlyFlakeDetectionRetryPolicy = providedContext.earlyFlakeDetectionRetryPolicy || {
  durationRetryCounts: [],
  schedulingRetryCount: 0,
}
const earlyFlakeDetectionRetries = earlyFlakeDetectionRetryPolicy.schedulingRetryCount
const isEfdSuiteAdmissionEnabled = providedContext.isEfdSuiteAdmissionEnabled === true
const isEarlyFlakeDetectionEnabled = providedContext.isEarlyFlakeDetectionEnabled === true
const knownTests = providedContext.knownTests || {}
const modifiedFiles = providedContext.modifiedFiles || {}
const quarantinedTests = providedContext.quarantinedTests || {}
const isRumCorrelationEnabled = providedContext.isRumCorrelationEnabled !== false
const rumTestExecutionIdCookieName = providedContext.rumTestExecutionIdCookieName
const testPropertiesByFilepath = providedContext.testPropertiesByFilepath || {}
const setVitestTaskFn = globalThis[Symbol.for('dd-trace.vitest.set-fn')]
const importVitestBrowserContext = globalThis[Symbol.for('dd-trace.vitest.browser-context-importer')]
const earlyFlakeDetectionRetriesByTask = new WeakMap()
const earlyFlakeDetectionSkippedResults = new WeakMap()
const earlyFlakeDetectionStartByTask = new WeakMap()
const nextAttemptIndexByTask = new WeakMap()
const retryAttemptIndexByTask = new WeakMap()
const usedRumTestExecutionIds = new Set()
let browserCommands
let now
let timeOrigin
// Use an unfaked monotonic clock in Node and Vitest's parent frame in Browser Mode.
if (typeof globalThis.process?.uptime === 'function') {
  now = () => globalThis.process.uptime() * 1000
  timeOrigin = Date.now() - now()
} else {
  const clock = globalThis.window?.parent && globalThis.window.parent !== globalThis.window
    ? globalThis.window.parent.performance
    : globalThis.performance
  now = clock ? clock.now.bind(clock) : Date.now
  timeOrigin = Number.isFinite(clock?.timeOrigin) ? clock.timeOrigin : Date.now() - now()
}

/**
 * Requests permission from the Vitest main process to schedule Browser Mode EFD retries for one suite.
 *
 * @param {string} testSuite
 * @param {boolean} hasNewTest
 * @returns {Promise<boolean>}
 */
async function requestBrowserEfdSuiteAdmission (testSuite, hasNewTest) {
  try {
    if (!browserCommands) {
      const vitestBrowser = await importVitestBrowserContext()
      browserCommands = vitestBrowser.commands
    }
    return await browserCommands[efdSuiteAdmissionBrowserCommand](testSuite, hasNewTest) === true
  } catch (error) {
    // Browser Mode setup runs without dd-trace, so the tracer logger is unavailable.
    globalThis.console?.error('Datadog Test Optimization could not request Vitest EFD suite admission.', error)
    return false
  }
}

if (isNoWorkerInitActive) {
  // eslint-disable-next-line no-empty-pattern
  beforeAll(async function ({}, suite) {
    suite ||= arguments[0]
    const efdSuiteCandidate = getEarlyFlakeDetectionSuiteCandidate(suite)
    const isEfdSuiteAdmissionAllowed = !efdSuiteCandidate || !isEfdSuiteAdmissionEnabled ||
      await requestBrowserEfdSuiteAdmission(efdSuiteCandidate.testSuite, efdSuiteCandidate.hasNewTest)
    applyExecutionChanges(suite, isEfdSuiteAdmissionAllowed)
  })

  beforeEach(function ({ onTestFinished, task, skip }) {
    const testSuite = getTestSuite(task)
    const testName = getTestName(task)
    const isAttemptToFixTest = attemptToFixTests[testSuite]?.[testName]
    const isEarlyFlakeDetectionTestAttempt = isEarlyFlakeDetectionTask(task)
    const isQuarantinedTest = quarantinedTests[testSuite]?.[testName] && !isAttemptToFixTest
    const attemptIndex = getNextAttemptIndex(task)
    const attemptStart = now()
    if (attemptIndex > 0) {
      recordTestOptimizationStatus(task, attemptIndex - 1)
    }

    if (!isAttemptToFixTest && disabledTests[testSuite]?.[testName]) {
      skip('Skipped by Datadog Test Optimization')
    } else if (isAttemptToFixTest && attemptIndex > 0) {
      task.result.state = 'run'
    } else if (isEarlyFlakeDetectionTestAttempt) {
      const isSkippedRepeat = prepareEarlyFlakeDetectionAttempt(task, attemptIndex)
      if (!isSkippedRepeat && attemptIndex > 0) {
        task.result.state = 'run'
      }
    }

    prepareRumCorrelation(task, attemptIndex)

    onTestFinished(() => {
      recordTestAttemptTiming(task, attemptIndex, attemptStart)
      recordRetryErrorCount(task)
      if (
        (isAttemptToFixTest || isEarlyFlakeDetectionTestAttempt || isQuarantinedTest) &&
        attemptIndex === getFinalAttemptIndex(task)
      ) {
        if (isAttemptToFixTest || isEarlyFlakeDetectionTestAttempt) {
          recordTestOptimizationStatus(task, attemptIndex, true)
        }
        switchQuarantinedFinalFailure(task, attemptIndex)
      }
      finishRumCorrelation(task, attemptIndex)
    })
  })

  afterEach(function ({ task }) {
    const attemptIndex = task.meta.__ddTestOptCurrentAttemptIndex
    const restoredEarlyFlakeDetectionResult = restoreEarlyFlakeDetectionSkippedResult(task)
    if (!restoredEarlyFlakeDetectionResult && attemptIndex === getFinalAttemptIndex(task)) {
      recordTestOptimizationStatus(task, attemptIndex)
    }
    if (!restoredEarlyFlakeDetectionResult) {
      switchQuarantinedFinalFailure(task, attemptIndex)
    }
  })
}

function applyExecutionChanges (suite, isEfdSuiteAdmissionAllowed) {
  const tasks = suite?.tasks
  if (tasks) {
    for (const task of tasks) {
      if (task.type === 'suite') {
        applyExecutionChanges(task, isEfdSuiteAdmissionAllowed)
        continue
      }

      const testSuite = getTestSuite(task)
      const testName = getTestName(task)
      if (attemptToFixTests[testSuite]?.[testName]) {
        task.retry = 0
        task.repeats = attemptToFixRetries
        task.meta.__ddTestOptAtfRetries = attemptToFixRetries
      } else if (disabledTests[testSuite]?.[testName]) {
        task.mode = 'skip'
      } else if (isEfdSuiteAdmissionAllowed && isEarlyFlakeDetectionTest(testSuite, testName)) {
        task.retry = 0
        task.repeats = earlyFlakeDetectionRetries
        task.meta.__ddTestOptEfdRetries = earlyFlakeDetectionRetries
      }
      wrapRetryCondition(task)
    }
  }
}

function getNextAttemptIndex (task) {
  const attemptIndex = nextAttemptIndexByTask.get(task) || 0
  nextAttemptIndexByTask.set(task, attemptIndex + 1)
  task.meta.__ddTestOptCurrentAttemptIndex = attemptIndex

  const repeatCount = task.result?.repeatCount || 0
  const retryAttempt = retryAttemptIndexByTask.get(task)
  const retryAttemptIndex = retryAttempt?.repeatCount === repeatCount ? retryAttempt.index + 1 : 0
  retryAttemptIndexByTask.set(task, {
    index: retryAttemptIndex,
    repeatCount,
  })

  return attemptIndex
}

/**
 * Sets the RUM correlation cookie for a sequential browser test attempt.
 *
 * @param {object} task
 * @param {number} attemptIndex
 * @returns {void}
 */
function prepareRumCorrelation (task, attemptIndex) {
  // A per-origin cookie cannot identify overlapping attempts without racing.
  if (!isRumCorrelationEnabled || isConcurrentTask(task)) return

  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof rumTestExecutionIdCookieName !== 'string'
  ) {
    return
  }

  const testExecutionId = generateTestExecutionId()
  if (
    !testExecutionId ||
    usedRumTestExecutionIds.has(testExecutionId) ||
    !setRumCorrelationCookie(testExecutionId)
  ) {
    return
  }

  usedRumTestExecutionIds.add(testExecutionId)
  task.meta.__ddTestOptRumTestExecutionIds ||= []
  task.meta.__ddTestOptRumTestExecutionIds[attemptIndex] = testExecutionId
  recordRumActivity(task, attemptIndex)
}

/**
 * Records whether RUM was active and clears the attempt cookie.
 *
 * @param {object} task
 * @param {number} attemptIndex
 * @returns {void}
 */
function finishRumCorrelation (task, attemptIndex) {
  const testExecutionId = task.meta.__ddTestOptRumTestExecutionIds?.[attemptIndex]
  if (!testExecutionId) return

  recordRumActivity(task, attemptIndex)
  clearRumCorrelationCookie(testExecutionId)
}

/**
 * Retains evidence that RUM was active at any point observed during the attempt.
 *
 * @param {object} task
 * @param {number} attemptIndex
 * @returns {void}
 */
function recordRumActivity (task, attemptIndex) {
  if (!getIsRumActive(getRum())) return

  task.meta.__ddTestOptRumActive ||= []
  task.meta.__ddTestOptRumActive[attemptIndex] = true
}

/**
 * Returns the RUM public API without letting application-defined accessors fail a test.
 *
 * @returns {object|undefined}
 */
function getRum () {
  try {
    return window.DD_RUM
  } catch {}
}

/**
 * Returns whether the current RUM session is active.
 *
 * @param {object|undefined} rum
 * @returns {boolean}
 */
function getIsRumActive (rum) {
  if (!rum) return false
  if (typeof rum.getInternalContext !== 'function') return false

  try {
    return !!rum.getInternalContext()
  } catch {
    return false
  }
}

/**
 * Returns whether a task or any containing suite is concurrent.
 *
 * @param {object} task
 * @returns {boolean}
 */
function isConcurrentTask (task) {
  let currentTask = task
  while (currentTask) {
    if (currentTask.concurrent === true) return true
    currentTask = currentTask.suite
  }
  return false
}

/**
 * Generates a positive 63-bit decimal test execution ID.
 *
 * @returns {string|undefined}
 */
function generateTestExecutionId () {
  // This setup file executes in a browser even though lint validates it against the package's Node.js target.
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  if (typeof globalThis.crypto?.getRandomValues !== 'function') return

  const words = new Uint32Array(2)
  try {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    globalThis.crypto.getRandomValues(words)
  } catch {
    return
  }

  words[0] &= 0x7F_FF_FF_FF
  if (words[0] === 0 && words[1] === 0) return

  return ((BigInt(words[0]) << 32n) | BigInt(words[1])).toString(10)
}

/**
 * Sets and verifies the RUM correlation cookie for the current origin.
 *
 * @param {string} testExecutionId
 * @returns {boolean}
 */
function setRumCorrelationCookie (testExecutionId) {
  try {
    // eslint-disable-next-line unicorn/no-document-cookie
    document.cookie = `${rumTestExecutionIdCookieName}=${testExecutionId}; path=/`
    return getRumCorrelationCookie() === testExecutionId
  } catch {
    return false
  }
}

/**
 * Clears the RUM correlation cookie if it still belongs to this attempt.
 *
 * @param {string} testExecutionId
 * @returns {void}
 */
function clearRumCorrelationCookie (testExecutionId) {
  try {
    if (getRumCorrelationCookie() === testExecutionId) {
      // eslint-disable-next-line unicorn/no-document-cookie
      document.cookie = `${rumTestExecutionIdCookieName}=; path=/; max-age=0`
    }
  } catch {}
}

/**
 * Returns the current RUM correlation cookie value.
 *
 * @returns {string|undefined}
 */
function getRumCorrelationCookie () {
  const prefix = `${rumTestExecutionIdCookieName}=`
  for (const cookie of document.cookie.split(';')) {
    const normalizedCookie = cookie.trim()
    if (normalizedCookie.startsWith(prefix)) {
      return normalizedCookie.slice(prefix.length)
    }
  }
}

function recordTestOptimizationStatus (task, attemptIndex = task.result?.repeatCount || 0, onlyIfNewErrors = false) {
  const testSuite = getTestSuite(task)
  const testName = getTestName(task)

  if (attemptToFixTests[testSuite]?.[testName]) {
    recordAttemptToFixStatus(task, attemptIndex, onlyIfNewErrors)
  } else if (isEarlyFlakeDetectionTask(task)) {
    recordEarlyFlakeDetectionStatus(task, attemptIndex, onlyIfNewErrors)
  } else if (task.repeats > 0) {
    recordManualRepeatStatus(task, attemptIndex)
  }
}

function recordAttemptToFixStatus (task, attemptIndex, onlyIfNewErrors) {
  if (onlyIfNewErrors && !hasNewErrors(task.meta.__ddTestOptAtfErrorCounts, attemptIndex, task)) {
    return
  }

  task.meta.__ddTestOptAtfStatuses ||= []
  task.meta.__ddTestOptAtfErrorCounts ||= []
  task.meta.__ddTestOptAtfStatuses[attemptIndex] = getAttemptStatus(
    task,
    task.meta.__ddTestOptAtfErrorCounts,
    attemptIndex
  )
  task.meta.__ddTestOptAtfErrorCounts[attemptIndex] = task.result?.errors?.length || 0

  if (
    attemptIndex === getAttemptToFixRetryCount(task) &&
    task.meta.__ddTestOptAtfStatuses.includes('fail') &&
    task.result?.state === 'pass'
  ) {
    task.result.state = 'fail'
  }
}

function recordEarlyFlakeDetectionStatus (task, attemptIndex, onlyIfNewErrors) {
  if (restoreEarlyFlakeDetectionSkippedResult(task)) {
    return
  }

  const retryCount = earlyFlakeDetectionRetriesByTask.get(task)
  if (retryCount !== undefined && attemptIndex > retryCount) {
    return
  }

  if (onlyIfNewErrors && !hasNewErrors(task.meta.__ddTestOptEfdErrorCounts, attemptIndex, task)) {
    return
  }

  if (!earlyFlakeDetectionRetriesByTask.has(task)) {
    const retryCount = getEarlyFlakeDetectionRetryCount(task)
    earlyFlakeDetectionRetriesByTask.set(task, retryCount)
    task.repeats = retryCount
    task.meta.__ddTestOptEfdRetries = retryCount
    if (retryCount === 0) {
      task.meta.__ddTestOptEfdAbortReason = 'slow'
    }
  }

  task.meta.__ddTestOptEfdStatuses ||= []
  task.meta.__ddTestOptEfdErrorCounts ||= []
  task.meta.__ddTestOptEfdStatuses[attemptIndex] = getAttemptStatus(
    task,
    task.meta.__ddTestOptEfdErrorCounts,
    attemptIndex
  )
  task.meta.__ddTestOptEfdErrorCounts[attemptIndex] = task.result?.errors?.length || 0

  if (attemptIndex === getEarlyFlakeDetectionRetryCountForTask(task) &&
    task.meta.__ddTestOptEfdStatuses.includes('pass')) {
    task.result.state = 'pass'
  }
}

function recordManualRepeatStatus (task, attemptIndex) {
  task.meta.__ddTestOptRepeatStatuses ||= []
  task.meta.__ddTestOptRepeatErrorCounts ||= []
  task.meta.__ddTestOptRepeatStatuses[attemptIndex] = getManualRepeatStatus(
    task,
    task.meta.__ddTestOptRepeatErrorCounts,
    attemptIndex
  )
  task.meta.__ddTestOptRepeatErrorCounts[attemptIndex] = task.result?.errors?.length || 0
}

/**
 * Records cumulative errors at the end of each configured retry attempt.
 *
 * @param {object} task
 * @returns {void}
 */
function recordRetryErrorCount (task) {
  const retryLimit = getRetryLimit(task)
  if (retryLimit <= 0) return

  const retryCount = task.result?.retryCount || 0
  task.meta.__ddTestOptRetryErrorCounts ||= []
  task.meta.__ddTestOptRetryErrorCounts[retryCount] = task.result?.errors?.length || 0
}

/**
 * Records the wall-clock start and elapsed time for one retry or repeat execution.
 *
 * @param {object} task
 * @param {number} attemptIndex
 * @param {number} attemptStart
 * @returns {void}
 */
function recordTestAttemptTiming (task, attemptIndex, attemptStart) {
  task.meta.__ddTestOptAttemptStartTimes ||= []
  task.meta.__ddTestOptAttemptDurations ||= []
  task.meta.__ddTestOptAttemptStartTimes[attemptIndex] = timeOrigin + attemptStart
  task.meta.__ddTestOptAttemptDurations[attemptIndex] = now() - attemptStart
}

/**
 * Returns the configured retry count for numeric and object-form retry options.
 *
 * @param {object} task
 * @returns {number}
 */
function getRetryLimit (task) {
  return typeof task.retry === 'number' ? task.retry : task.retry?.count || 0
}

/**
 * Wraps Vitest's retry condition so final-attempt handling follows the condition's actual result.
 *
 * @param {object} task
 * @returns {void}
 */
function wrapRetryCondition (task) {
  if (typeof task.retry !== 'object' || !task.retry?.condition || getRetryLimit(task) === 0) return

  const condition = task.retry.condition
  task.retry = {
    ...task.retry,
    condition (error) {
      let shouldRetry = false
      if (condition instanceof RegExp) {
        shouldRetry = condition.test(error?.message || '')
      } else if (typeof condition === 'function') {
        shouldRetry = condition(error)
      }

      if (!shouldRetry && (task.result?.repeatCount || 0) >= (task.repeats || 0)) {
        const attemptIndex = task.meta.__ddTestOptCurrentAttemptIndex
        recordTestOptimizationStatus(task, attemptIndex)
        markQuarantinedFailure(task)
      }
      return shouldRetry
    },
  }
}

function restoreEarlyFlakeDetectionSkippedResult (task) {
  if (!task.meta.__ddTestOptEfdSkipCurrentAttempt) {
    return false
  }

  delete task.meta.__ddTestOptEfdSkipCurrentAttempt
  const skippedResult = earlyFlakeDetectionSkippedResults.get(task)
  if (skippedResult) {
    task.result = skippedResult
    earlyFlakeDetectionSkippedResults.delete(task)
  }
  return true
}

function hasNewErrors (errorCounts, attemptIndex, task) {
  const recordedErrorCount = errorCounts?.[attemptIndex]
  const previousErrorCount = recordedErrorCount ?? getPreviousErrorCount(errorCounts, attemptIndex)
  return (task.result?.errors?.length || 0) > previousErrorCount
}

function getFinalAttemptIndex (task) {
  const testSuite = getTestSuite(task)
  const testName = getTestName(task)

  if (attemptToFixTests[testSuite]?.[testName]) {
    return getAttemptToFixRetryCount(task)
  }
  if (isEarlyFlakeDetectionTask(task)) {
    return getEarlyFlakeDetectionRetryCountForTask(task)
  }

  const attemptIndex = task.meta.__ddTestOptCurrentAttemptIndex
  const repeatCount = task.result?.repeatCount || 0
  const repeatLimit = task.repeats || 0
  const retryAttemptIndex = retryAttemptIndexByTask.get(task)?.index || 0
  const retryLimit = getRetryLimit(task)
  const retriesRemaining = task.result?.state === 'fail' || task.result?.state === 'run'
    ? Math.max(retryLimit - retryAttemptIndex, 0)
    : 0
  const repeatsRemaining = Math.max(repeatLimit - repeatCount, 0)

  return attemptIndex + retriesRemaining + (repeatsRemaining * (retryLimit + 1))
}

function switchQuarantinedFinalFailure (task, attemptIndex) {
  const testSuite = getTestSuite(task)
  const testName = getTestName(task)
  if (
    !quarantinedTests[testSuite]?.[testName] ||
    attemptToFixTests[testSuite]?.[testName] ||
    task.result?.state !== 'fail'
  ) {
    return
  }

  if (attemptIndex < getFinalAttemptIndex(task)) {
    return
  }

  markQuarantinedFailure(task)
}

/**
 * Converts a quarantined failure into the passing runner state expected by Vitest.
 *
 * @param {object} task
 * @returns {void}
 */
function markQuarantinedFailure (task) {
  const testSuite = getTestSuite(task)
  const testName = getTestName(task)
  if (
    !quarantinedTests[testSuite]?.[testName] ||
    attemptToFixTests[testSuite]?.[testName] ||
    task.result?.state !== 'fail'
  ) {
    return
  }

  task.meta.__ddTestOptQuarantinedFailed = true
  task.result.state = 'pass'
}

function getAttemptToFixRetryCount (task) {
  return task.meta.__ddTestOptAtfRetries ?? task.repeats
}

function getEarlyFlakeDetectionRetryCountForTask (task) {
  return earlyFlakeDetectionRetriesByTask.get(task) ?? task.meta.__ddTestOptEfdRetries ?? task.repeats
}

function getAttemptStatus (task, errorCounts, repeatCount) {
  const errorCount = task.result?.errors?.length || 0
  if (errorCount > getPreviousErrorCount(errorCounts, repeatCount)) {
    return 'fail'
  }
  return task.result?.state === 'fail' ? 'fail' : 'pass'
}

function getManualRepeatStatus (task, errorCounts, repeatCount) {
  const errorCount = task.result?.errors?.length || 0
  return errorCount > getPreviousErrorCount(errorCounts, repeatCount) ? 'fail' : 'pass'
}

function getPreviousErrorCount (errorCounts, repeatCount) {
  for (let index = repeatCount - 1; index >= 0; index--) {
    if (errorCounts[index] !== undefined) {
      return errorCounts[index]
    }
  }
  return 0
}

function prepareEarlyFlakeDetectionAttempt (task, attemptIndex) {
  if (attemptIndex === 0) {
    earlyFlakeDetectionStartByTask.set(task, now())
    return false
  }

  let retryCount = earlyFlakeDetectionRetriesByTask.get(task)
  if (retryCount === undefined) {
    retryCount = getEarlyFlakeDetectionRetryCount(task)
    earlyFlakeDetectionRetriesByTask.set(task, retryCount)
    task.repeats = retryCount
    task.meta.__ddTestOptEfdRetries = retryCount
    if (retryCount === 0) {
      task.meta.__ddTestOptEfdAbortReason = 'slow'
    }
  }

  if (attemptIndex <= retryCount) {
    earlyFlakeDetectionStartByTask.set(task, now())
    return false
  }

  if (!canReplaceVitestTaskFn()) {
    earlyFlakeDetectionStartByTask.set(task, now())
    return false
  }

  if (task.result) {
    earlyFlakeDetectionSkippedResults.set(task, {
      ...task.result,
      errors: task.result.errors?.slice(),
    })
  }
  task.meta.__ddTestOptEfdSkipCurrentAttempt = true
  replaceVitestTaskFn(task, noopTest)
  return true
}

function getEarlyFlakeDetectionRetryCount (task) {
  const executionStart = earlyFlakeDetectionStartByTask.get(task)
  const duration = executionStart === undefined ? task.result?.duration ?? 0 : now() - executionStart
  for (const { durationLimitMs, retryCount } of earlyFlakeDetectionRetryPolicy.durationRetryCounts) {
    if (duration < durationLimitMs) return retryCount
  }
  return 0
}

function noopTest () {}

/**
 * Returns whether Vitest's private task function setter is available.
 *
 * @returns {boolean}
 */
function canReplaceVitestTaskFn () {
  return typeof setVitestTaskFn === 'function'
}

/**
 * Replaces the function Vitest runs for a task.
 *
 * @param {object} task
 * @param {(...args: unknown[]) => unknown} testFn
 */
function replaceVitestTaskFn (task, testFn) {
  setVitestTaskFn(task, testFn)
}

function isEarlyFlakeDetectionTest (testSuite, testName) {
  if (!isEarlyFlakeDetectionEnabled || earlyFlakeDetectionRetries <= 0) return false
  if (isModifiedTest(testSuite)) return true
  const testsForSuite = knownTests[testSuite] || []
  return !testsForSuite.includes(testName)
}

/**
 * Returns whether Datadog admitted this task for EFD retries.
 *
 * @param {object} task
 * @returns {boolean}
 */
function isEarlyFlakeDetectionTask (task) {
  return task.meta.__ddTestOptEfdRetries !== undefined
}

/**
 * Returns suite admission data when a collected suite contains an EFD candidate.
 *
 * @param {object} suite
 * @returns {{ hasNewTest: boolean, testSuite: string }|undefined}
 */
function getEarlyFlakeDetectionSuiteCandidate (suite) {
  const tasks = suite?.tasks
  if (!tasks) return

  let candidate
  for (const task of tasks) {
    if (task.type === 'suite') {
      const nestedCandidate = getEarlyFlakeDetectionSuiteCandidate(task)
      if (nestedCandidate) {
        candidate ||= nestedCandidate
        candidate.hasNewTest ||= nestedCandidate.hasNewTest
      }
      continue
    }

    if (task.mode === 'skip' || task.mode === 'todo') continue

    const testSuite = getTestSuite(task)
    const testName = getTestName(task)
    if (attemptToFixTests[testSuite]?.[testName] || disabledTests[testSuite]?.[testName]) continue
    if (!isEarlyFlakeDetectionTest(testSuite, testName)) continue

    candidate ||= {
      hasNewTest: false,
      testSuite,
    }
    candidate.hasNewTest ||= isNewTest(testSuite, testName)
  }
  return candidate
}

/**
 * Returns whether a collected test is absent from the known-tests response.
 *
 * @param {string} testSuite
 * @param {string} testName
 * @returns {boolean}
 */
function isNewTest (testSuite, testName) {
  return !(knownTests[testSuite] || []).includes(testName)
}

function isModifiedTest (testSuite) {
  return modifiedFiles[testSuite]?.length > 0
}

function getTestSuite (task) {
  const filepath = task.file.filepath
  return testPropertiesByFilepath[filepath]?.testSuite ||
    testPropertiesByFilepath[normalizePath(filepath)]?.testSuite ||
    normalizePath(filepath)
}

function getTestName (task) {
  let testName = task.name
  let currentTask = task.suite

  while (currentTask) {
    if (currentTask.name) {
      testName = `${currentTask.name} ${testName}`
    }
    currentTask = currentTask.suite
  }

  return testName
}

function normalizePath (filepath) {
  return filepath.replaceAll('\\', '/')
}

function getIsNoWorkerInitActive () {
  try {
    // eslint-disable-next-line eslint-rules/eslint-process-env
    const value = process.env[VITEST_NO_WORKER_INIT_ACTIVE_ENV]
    return value === '1' || value === 'true'
  } catch {
    return false
  }
}

function getProvidedContext () {
  try {
    return parseProvidedContextValue(inject('_ddVitestWorkerSetup'))
  } catch {
    try {
      return parseProvidedContextValue(globalThis.__vitest_worker__.providedContext._ddVitestWorkerSetup)
    } catch {
      return {}
    }
  }
}

/**
 * Restore context serialized to keep Vitest's inline browser bootstrap script valid.
 *
 * @param {object|string|undefined} value
 * @returns {object}
 */
function parseProvidedContextValue (value) {
  if (typeof value !== 'string' || !value.startsWith(SERIALIZED_CONTEXT_PREFIX)) return value || {}

  try {
    return JSON.parse(value.slice(SERIALIZED_CONTEXT_PREFIX.length))
  } catch {
    return {}
  }
}
