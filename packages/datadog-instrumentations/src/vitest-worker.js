'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { fileURLToPath } = require('node:url')
const { isMainThread, parentPort } = require('node:worker_threads')

const { channel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
const { getEfdRetryCountForDuration } = require('../../dd-trace/src/ci-visibility/efd-retry-policy')
const {
  DYNAMIC_NAME_RE,
  getTestSuitePath,
  recordAttemptToFixExecution,
  logAttemptToFixTestExecution,
  VITEST_WORKER_EFD_SUITE_ADMISSION_REQUEST_CODE,
  VITEST_WORKER_EFD_SUITE_ADMISSION_RESPONSE_CODE,
} = require('../../dd-trace/src/plugins/util/test')
const { getChannelPromise } = require('./helpers/channel')
const { addHook } = require('./helpers/instrument')
const {
  testStartCh,
  testFinishTimeCh,
  testPassCh,
  testErrorCh,
  testDiWaitCh,
  testSkipCh,
  testFnCh,
  testSuiteStartCh,
  testSuiteFinishCh,
  testSuiteErrorCh,
  findExportByName,
  getTestRunnerExport,
  getTypeTasks,
  getTestName,
  getProvidedContext,
  realpath,
  isFlakyTestRetriesEnabledForTask,
  getVitestTestProperties,
} = require('./vitest-util')

const EFD_SUITE_ADMISSION_TIMEOUT_MS = 5000
const logSubmissionFlushCh = channel('ci:log-submission:flush')
const taskToCtx = new WeakMap()
const taskToTestProperties = new WeakMap()
const taskToStatuses = new WeakMap()
const taskToReportedErrorCount = new WeakMap()
const runnersWithLogSubmissionCleanup = new WeakSet()
const attemptToFixTaskToStatuses = new WeakMap()
const fileToHasConcurrentTests = new WeakMap()
const fileToEfdSuiteAdmission = new WeakMap()
const pendingEfdSuiteAdmissionRequests = new Map()
const originalHookFns = new WeakMap()
const newTasks = new WeakSet()
const dynamicNameTasks = new WeakSet()
const disabledTasks = new WeakSet()
const quarantinedTasks = new WeakSet()
const attemptToFixTasks = new WeakSet()
const attemptToFixRetryTasks = new WeakSet()
const modifiedTasks = new WeakSet()
const efdRetryTasks = new WeakSet()
const efdDeterminedRetries = new WeakMap()
const efdSlowAbortedTasks = new WeakSet()
const efdExecutionStartByTask = new WeakMap()
const efdSkippedRetryResults = new WeakMap()
const attemptToFixExecutions = new Map()
const loggedAttemptToFixTests = new Set()
const switchedStatuses = new WeakMap()
let vitestGetFn = null
let vitestSetFn = null
let vitestGetHooks = null
let preciseCoverageSession
let didInitializeEfdSuiteAdmissionTransport = false
let nextEfdSuiteAdmissionRequestId = 0
let sendEfdSuiteAdmissionMessage
let isPreciseCoverageUnavailable = false
let vitestCoverageSnapshot
const wrappedCoverageWorkerStates = new WeakSet()
const nonIsolatedCoverageFiles = new Set()

/**
 * Sends a command to a Node.js inspector session.
 *
 * @param {import('node:inspector').Session} session
 * @param {string} method
 * @param {object} [params]
 * @returns {Promise<object>}
 */
function postInspectorCommand (session, method, params) {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => {
      if (error) {
        reject(error)
      } else {
        resolve(result || {})
      }
    })
  })
}

async function startPreciseCoverage () {
  if (preciseCoverageSession) return true
  if (isPreciseCoverageUnavailable) return false

  let session
  try {
    const inspector = require('node:inspector')
    session = new inspector.Session()
    session.connect()
    await postInspectorCommand(session, 'Profiler.enable')
    await postInspectorCommand(session, 'Profiler.startPreciseCoverage', {
      callCount: false,
      detailed: false,
    })
    preciseCoverageSession = session
    return true
  } catch (error) {
    isPreciseCoverageUnavailable = true
    try {
      session?.disconnect()
    } catch {}
    log.warn('Could not start Vitest TIA code coverage: %s', error?.message)
    return false
  }
}

function getCoverageFilename (url) {
  if (!url) return

  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url)
    } catch {
      return
    }
  }

  if (path.isAbsolute(url)) return url
}

function isFileInRepository (filename, repositoryRoot) {
  const relativeFilename = path.relative(repositoryRoot, filename)
  return relativeFilename !== '..' &&
    !relativeFilename.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeFilename) &&
    !relativeFilename.startsWith(`node_modules${path.sep}`) &&
    !relativeFilename.includes(`${path.sep}node_modules${path.sep}`)
}

function isV8ScriptCovered (scriptCoverage) {
  for (const functionCoverage of scriptCoverage.functions) {
    for (const range of functionCoverage.ranges) {
      if (range.count > 0) return true
    }
  }
  return false
}

function getCoveredFilesFromV8Result (coverage, repositoryRoot) {
  const coveredFiles = []
  const scriptCoverageResults = coverage?.result
  if (scriptCoverageResults) {
    for (const scriptCoverage of scriptCoverageResults) {
      if (!isV8ScriptCovered(scriptCoverage)) continue

      const coverageFilename = getCoverageFilename(scriptCoverage.url)
      if (!coverageFilename) continue

      const filename = realpath(coverageFilename)
      if (isFileInRepository(filename, repositoryRoot)) {
        coveredFiles.push(filename)
      }
    }
  }
  return coveredFiles
}

function getVitestCoverageOptions () {
  return globalThis.__vitest_worker__?.config?.coverage
}

/**
 * Check whether the current Vitest worker reuses its module cache across test suites.
 *
 * @returns {boolean}
 */
function isNonIsolatedRun () {
  const config = globalThis.__vitest_worker__?.config
  if (config?.isolate === false) return true

  return config?.poolOptions?.[config.pool]?.isolate === false
}

/**
 * Conservatively include files covered by earlier suites when Vitest reuses its module cache.
 *
 * @param {string[] | undefined} coverageFiles
 * @returns {string[] | undefined}
 */
function includePreviouslyCoveredFiles (coverageFiles) {
  if (!coverageFiles || !isNonIsolatedRun()) return coverageFiles

  // TODO: Track module cache hits per suite instead; cumulative coverage can under-skip with isolate:false.
  for (const filename of coverageFiles) {
    nonIsolatedCoverageFiles.add(filename)
  }
  return [...nonIsolatedCoverageFiles]
}

function usesVitestV8CoverageSnapshot (coverageOptions) {
  return coverageOptions?.enabled === true &&
    coverageOptions.provider === 'v8'
}

async function getPreciseCoverageFiles (repositoryRoot) {
  if (!await startPreciseCoverage()) return

  try {
    const coverage = await postInspectorCommand(preciseCoverageSession, 'Profiler.takePreciseCoverage')
    return getCoveredFilesFromV8Result(coverage, repositoryRoot)
  } catch (error) {
    isPreciseCoverageUnavailable = true
    try {
      preciseCoverageSession.disconnect()
    } catch {}
    preciseCoverageSession = undefined
    log.warn('Could not collect Vitest TIA code coverage: %s', error?.message)
  }
}

function getVitestCoverageFiles (repositoryRoot) {
  return getCoveredFilesFromV8Result(vitestCoverageSnapshot, repositoryRoot)
}

function wrapVitestCoverageRpc () {
  const workerState = globalThis.__vitest_worker__
  if (!workerState?.rpc || wrappedCoverageWorkerStates.has(workerState)) return

  wrappedCoverageWorkerStates.add(workerState)
  workerState.rpc = new Proxy(workerState.rpc, {
    get (target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== 'onAfterSuiteRun' || typeof value !== 'function') return value

      return function (metadata) {
        const coverage = metadata?.coverage
        if (typeof coverage === 'string') {
          try {
            vitestCoverageSnapshot = JSON.parse(fs.readFileSync(coverage, 'utf8'))
          } catch (error) {
            log.warn('Could not read Vitest V8 coverage: %s', error?.message)
            vitestCoverageSnapshot = undefined
          }
        } else {
          vitestCoverageSnapshot = coverage
        }
        return value.apply(this, arguments)
      }
    },
  })
}

function waitForHitProbe () {
  const promises = {}
  testDiWaitCh.publish({ promises })
  return promises.hitBreakpointPromise
}

function getVitestTestStatus (test, retryCount) {
  if (test.result.state !== 'fail' && (!test.repeats || (test.retry ?? 0) === retryCount)) {
    return 'pass'
  }
  return 'fail'
}

function getFinalAttemptToFixStatus (task, state, isSwitchedStatus, testCtx) {
  if (isSwitchedStatus && attemptToFixTasks.has(task) && testCtx?.status) {
    return testCtx.status
  }

  return state === 'fail' ? 'fail' : 'pass'
}

/**
 * Return the normalized test suite path prepared by the main process for a Vitest task.
 *
 * @param {{ file: { filepath: string } }} task
 * @returns {string}
 */
function getTaskTestSuite (task) {
  return taskToTestProperties.get(task)?.testSuite || task.file.filepath
}

function recordFinalAttemptToFixExecution (task, status, providedContext) {
  const statuses = attemptToFixTaskToStatuses.get(task)
  if (statuses && statuses.length <= providedContext.testManagementAttemptToFixRetries) {
    statuses.push(status)
  }

  recordAttemptToFixExecution(attemptToFixExecutions, {
    testSuite: getTaskTestSuite(task),
    testName: getTestName(task),
    status,
    isDisabled: disabledTasks.has(task),
    isQuarantined: quarantinedTasks.has(task),
  })
}

function disableFrameworkRetries (task) {
  task.retry = 0
}

function getCurrentAttemptTestError (task, errors) {
  if (!errors?.length) return

  const previousErrorCount = taskToReportedErrorCount.get(task) ?? 0
  const testError = errors[previousErrorCount] ?? errors[0]
  taskToReportedErrorCount.set(task, errors.length)
  return testError
}

function wrapTestScopedFn (task, fn) {
  return shimmer.wrapFunction(fn, fn => function (...args) {
    return testFnCh.runStores(taskToCtx.get(task), () => fn.apply(this, args))
  })
}

function wrapBeforeEachCleanupResult (task, result) {
  if (typeof result === 'function') {
    return wrapTestScopedFn(task, result)
  }

  if (result && typeof result.then === 'function') {
    return result.then(cleanupFn => wrapBeforeEachCleanupResult(task, cleanupFn))
  }

  return result
}

/**
 * Returns whether a Vitest task tree includes any concurrent task.
 *
 * @param {Array<{ type?: string, concurrent?: boolean, tasks?: object[] }>|undefined} tasks
 * @returns {boolean}
 */
function hasConcurrentTask (tasks) {
  if (!tasks) return false

  for (const task of tasks) {
    if (task.concurrent === true) return true
    if (hasConcurrentTask(task.tasks)) return true
  }

  return false
}

/**
 * Returns whether a Vitest file includes any concurrent test.
 *
 * @param {{ tasks?: object[] }} file
 * @returns {boolean}
 */
function hasConcurrentTests (file) {
  const cached = fileToHasConcurrentTests.get(file)
  if (cached !== undefined) return cached

  const hasConcurrent = hasConcurrentTask(file.tasks)
  fileToHasConcurrentTests.set(file, hasConcurrent)
  return hasConcurrent
}

/**
 * Returns whether a collected Vitest file contains a runnable new test eligible for EFD.
 *
 * @param {{ filepath: string, tasks?: object[] }} file
 * @param {object} providedContext
 * @returns {boolean}
 */
function hasRunnableNewTest (file, providedContext) {
  for (const task of getTypeTasks(file.tasks)) {
    if (task.mode === 'skip' || task.mode === 'todo') continue

    const testProperties = getVitestTestProperties(providedContext, file.filepath, getTestName(task))
    if (testProperties.isNew && !testProperties.isAttemptToFix && !testProperties.isDisabled) {
      return true
    }
  }
  return false
}

/**
 * Resolves and removes one pending EFD suite admission request.
 *
 * @param {number} requestId
 * @param {boolean} allowed
 * @returns {void}
 */
function finishEfdSuiteAdmissionRequest (requestId, allowed) {
  const request = pendingEfdSuiteAdmissionRequests.get(requestId)
  if (!request) return

  clearTimeout(request.timeout)
  pendingEfdSuiteAdmissionRequests.delete(requestId)
  request.resolve(allowed)
}

/**
 * Handles an EFD suite admission response from the Vitest main process.
 *
 * @param {unknown} message
 * @returns {void}
 */
function handleEfdSuiteAdmissionResponse (message) {
  if (!Array.isArray(message) || message[0] !== VITEST_WORKER_EFD_SUITE_ADMISSION_RESPONSE_CODE) return

  const { allowed, requestId } = message[1] || {}
  if (Number.isSafeInteger(requestId)) {
    finishEfdSuiteAdmissionRequest(requestId, allowed === true)
  }
}

/**
 * Returns the child-process or worker-thread sender used by the current Vitest worker.
 *
 * @returns {((message: unknown) => void)|undefined}
 */
function getEfdSuiteAdmissionSender () {
  if (didInitializeEfdSuiteAdmissionTransport) return sendEfdSuiteAdmissionMessage
  didInitializeEfdSuiteAdmissionTransport = true

  if (typeof process.send === 'function') {
    process.on('message', handleEfdSuiteAdmissionResponse)
    sendEfdSuiteAdmissionMessage = process.send.bind(process)
  } else if (!isMainThread && parentPort) {
    parentPort.on('message', handleEfdSuiteAdmissionResponse)
    sendEfdSuiteAdmissionMessage = parentPort.postMessage.bind(parentPort)
  }
  return sendEfdSuiteAdmissionMessage
}

/**
 * Requests permission from the Vitest main process to schedule EFD retries for one suite.
 *
 * @param {string} testSuite
 * @param {boolean} hasNewTest
 * @returns {Promise<boolean>}
 */
function requestEfdSuiteAdmission (testSuite, hasNewTest) {
  const sendMessage = getEfdSuiteAdmissionSender()
  if (!sendMessage) return Promise.resolve(false)

  const requestId = ++nextEfdSuiteAdmissionRequestId
  return new Promise(resolve => {
    const timeout = setTimeout(
      () => finishEfdSuiteAdmissionRequest(requestId, false),
      EFD_SUITE_ADMISSION_TIMEOUT_MS
    )
    timeout.unref?.()
    pendingEfdSuiteAdmissionRequests.set(requestId, { resolve, timeout })

    try {
      sendMessage([VITEST_WORKER_EFD_SUITE_ADMISSION_REQUEST_CODE, { hasNewTest, requestId, testSuite }])
    } catch {
      finishEfdSuiteAdmissionRequest(requestId, false)
    }
  })
}

/**
 * Requests a single EFD admission decision for all tests collected in a Vitest file.
 *
 * @param {{ file: { filepath: string, tasks?: object[] } }} task
 * @param {object} providedContext
 * @param {string|undefined} testSuite
 * @returns {Promise<boolean>}
 */
function isEfdSuiteAdmissionAllowed (task, providedContext, testSuite) {
  let admission = fileToEfdSuiteAdmission.get(task.file)
  if (admission) return admission

  admission = requestEfdSuiteAdmission(
    testSuite || task.file.filepath,
    hasRunnableNewTest(task.file, providedContext)
  )
  fileToEfdSuiteAdmission.set(task.file, admission)
  return admission
}

/**
 * Gets the task associated with a Vitest hook invocation.
 *
 * @param {unknown[]} args
 * @param {object} fallbackTask
 * @returns {object}
 */
function getTaskFromHookArgs (args, fallbackTask) {
  return args[0]?.task || fallbackTask
}

/**
 * Wraps a Vitest hook so it runs inside the span context for the current test.
 *
 * @param {'beforeEach'|'afterEach'} hookType
 * @param {Function} fn
 * @param {object} fallbackTask
 * @returns {Function}
 */
function wrapSuiteHookFn (hookType, fn, fallbackTask) {
  return shimmer.wrapFunction(fn, fn => function (...args) {
    const task = getTaskFromHookArgs(args, fallbackTask)
    const result = testFnCh.runStores(taskToCtx.get(task), () => fn.apply(this, args))

    if (hookType === 'beforeEach') {
      return wrapBeforeEachCleanupResult(task, result)
    }

    return result
  })
}

function wrapVitestTestRunner (VitestTestRunner) {
  // `onBeforeRunTask` is run before any repetition or attempt is run
  // `onBeforeRunTask` is an async function
  shimmer.wrap(VitestTestRunner.prototype, 'onBeforeRunTask', onBeforeRunTask => async function (task) {
    const testName = getTestName(task)

    const providedContext = getProvidedContext()
    const {
      isEarlyFlakeDetectionEnabled,
      isKnownTestsEnabled,
      earlyFlakeDetectionRetryPolicy,
      isTestManagementTestsEnabled,
      testManagementAttemptToFixRetries,
      isImpactedTestsEnabled,
    } = providedContext
    const testProperties = getVitestTestProperties(providedContext, task.file.filepath, testName)
    taskToTestProperties.set(task, testProperties)

    if (isTestManagementTestsEnabled) {
      const {
        isAttemptToFix,
        isDisabled,
        isQuarantined,
      } = testProperties
      if (isAttemptToFix) {
        if (task.repeats !== testManagementAttemptToFixRetries) {
          attemptToFixRetryTasks.add(task)
        }
        disableFrameworkRetries(task)
        task.repeats = testManagementAttemptToFixRetries
        attemptToFixTasks.add(task)
        attemptToFixTaskToStatuses.set(task, [])
      }
      if (isQuarantined) {
        quarantinedTasks.add(task)
      }
      if (isDisabled) {
        disabledTasks.add(task)
        if (!attemptToFixTasks.has(task)) {
          // we only actually skip if the test is not being attempted to be fixed
          task.mode = 'skip'
        }
      }
    }

    if (isImpactedTestsEnabled && testProperties.isModified) {
      modifiedTasks.add(task)
    }

    if (isKnownTestsEnabled && testProperties.isNew && !attemptToFixTasks.has(task)) {
      newTasks.add(task)
      if (DYNAMIC_NAME_RE.test(testName)) {
        dynamicNameTasks.add(task)
      }
    }

    const isEfdCandidate = isEarlyFlakeDetectionEnabled &&
      !attemptToFixTasks.has(task) &&
      !disabledTasks.has(task) &&
      (modifiedTasks.has(task) || newTasks.has(task))
    if (isEfdCandidate) {
      const isAdmissionAllowed = !providedContext.isEfdSuiteAdmissionEnabled ||
        await isEfdSuiteAdmissionAllowed(task, providedContext, testProperties.testSuite)
      if (isAdmissionAllowed) {
        efdRetryTasks.add(task)
        disableFrameworkRetries(task)
        task.repeats = earlyFlakeDetectionRetryPolicy.schedulingRetryCount
        taskToStatuses.set(task, [])
      }
    }

    return onBeforeRunTask.apply(this, arguments)
  })

  // `onAfterRunTask` is run after all repetitions or attempts are run
  // `onAfterRunTask` is an async function
  shimmer.wrap(VitestTestRunner.prototype, 'onAfterRunTask', onAfterRunTask => function (task) {
    const { isTestManagementTestsEnabled } = getProvidedContext()

    if (isTestManagementTestsEnabled) {
      const isAttemptingToFix = attemptToFixTasks.has(task)
      const isQuarantined = quarantinedTasks.has(task)

      if (isAttemptingToFix) {
        const statuses = attemptToFixTaskToStatuses.get(task)
        if (task.result.state === 'pass' && statuses?.includes('fail')) {
          switchedStatuses.set(task, task.result.state)
          task.result.state = 'fail'
        }
      }

      if (!isAttemptingToFix && isQuarantined) {
        if (task.result.state === 'fail') {
          switchedStatuses.set(task, task.result.state)
        }
        task.result.state = 'pass'
      }
    }

    if (efdRetryTasks.has(task)) {
      const statuses = taskToStatuses.get(task)
      // If the test has passed at least once, we consider it passed
      if (statuses.includes('pass')) {
        if (task.result.state === 'fail') {
          switchedStatuses.set(task, task.result.state)
        }
        task.result.state = 'pass'
      }
    }

    return onAfterRunTask.apply(this, arguments)
  })

  // test start (only tests that are not marked as skip or todo)
  // `onBeforeTryTask` is run for every repetition and attempt of the test
  shimmer.wrap(VitestTestRunner.prototype, 'onBeforeTryTask', onBeforeTryTask => async function (task, retryInfo) {
    if (!testPassCh.hasSubscribers && !testErrorCh.hasSubscribers && !testSkipCh.hasSubscribers) {
      return onBeforeTryTask.apply(this, arguments)
    }
    const testName = getTestName(task)
    let isNew = false
    const providedContext = getProvidedContext()
    const {
      isKnownTestsEnabled,
      isDiEnabled,
      earlyFlakeDetectionRetryPolicy,
    } = providedContext

    if (isKnownTestsEnabled) {
      isNew = newTasks.has(task)
    }

    const { retry: numAttempt, repeats: numRepetition } = retryInfo
    const isFailedTestReplayAllowed = !hasConcurrentTests(task.file)
    const isEfdManagedTask = efdRetryTasks.has(task)

    if (isEfdManagedTask && numRepetition > 0 && !efdDeterminedRetries.has(task)) {
      const previousExecutionStart = efdExecutionStartByTask.get(task)
      const duration = previousExecutionStart === undefined
        ? task.result?.duration ?? 0
        : performance.now() - previousExecutionStart
      const retryCount = getEfdRetryCountForDuration(duration, earlyFlakeDetectionRetryPolicy)
      efdDeterminedRetries.set(task, retryCount)
      task.repeats = retryCount
      if (retryCount === 0) {
        efdSlowAbortedTasks.add(task)
      }
    }

    const efdRetryCount = efdDeterminedRetries.get(task)
    if (isEfdManagedTask && efdRetryCount !== undefined && numRepetition > efdRetryCount) {
      if (task.result) {
        efdSkippedRetryResults.set(task, {
          ...task.result,
          errors: task.result.errors?.slice(),
        })
      }
      if (vitestSetFn) {
        const noop = function () {}
        noop.__ddTraceWrapped = true
        vitestSetFn(task, noop)
      }
      return onBeforeTryTask.apply(this, arguments)
    }
    if (isEfdManagedTask) {
      efdExecutionStartByTask.set(task, performance.now())
    }

    // We finish the previous test here because we know it has failed already
    if (numAttempt > 0) {
      const shouldWaitForHitProbe = isDiEnabled && isFailedTestReplayAllowed && numAttempt > 1
      if (shouldWaitForHitProbe) {
        await waitForHitProbe()
      }

      const promises = {}
      const shouldSetProbe = isDiEnabled && isFailedTestReplayAllowed && numAttempt === 1
      const ctx = taskToCtx.get(task)
      const testError = getCurrentAttemptTestError(task, task.result?.errors)
      if (ctx) {
        testErrorCh.publish({
          error: testError,
          shouldSetProbe,
          shouldWaitForHitProbe,
          promises,
          ...ctx.currentStore,
        })
        // We wait for the probe to be set
        if (promises.setProbePromise) {
          await promises.setProbePromise
        }
      }
    }

    const lastExecutionStatus = task.result.state
    const isAtf = attemptToFixTasks.has(task)
    const isEfd = efdRetryTasks.has(task)
    const shouldTrackStatuses = isEfd || isAtf
    const shouldFlipStatus = isEfd || isAtf
    const statuses = isAtf ? attemptToFixTaskToStatuses.get(task) : taskToStatuses.get(task)

    // These clauses handle task.repeats, whether EFD is enabled or not
    // The only thing that EFD does is to forcefully pass the test if it has passed at least once
    if (numRepetition > 0 && numRepetition < task.repeats) { // it may or may have not failed
      // Here we finish the earlier iteration,
      // as long as it's not the _last_ iteration (which will be finished normally)

      const ctx = taskToCtx.get(task)
      if (ctx) {
        if (lastExecutionStatus === 'fail') {
          const testError = getCurrentAttemptTestError(task, task.result?.errors)
          testErrorCh.publish({ error: testError, ...ctx.currentStore })
        } else {
          testPassCh.publish({ task, ...ctx.currentStore })
        }
        if (shouldTrackStatuses && statuses) {
          statuses.push(lastExecutionStatus)
        }
        if (shouldFlipStatus) {
          // If we don't "reset" the result.state to "pass", once a repetition fails,
          // vitest will always consider the test as failed, so we can't read the actual status
          // This means that we change vitest's behavior:
          // if the last attempt passes, vitest would consider the test as failed
          // but after this change, it will consider the test as passed
          task.result.state = 'pass'
        }
      }
    } else if (numRepetition === task.repeats) {
      if (shouldTrackStatuses && statuses) {
        statuses.push(lastExecutionStatus)
      }

      const ctx = taskToCtx.get(task)
      if (lastExecutionStatus === 'fail') {
        const testError = getCurrentAttemptTestError(task, task.result?.errors)
        testErrorCh.publish({ error: testError, ...ctx.currentStore })
      } else {
        testPassCh.publish({ task, ...ctx.currentStore })
      }
      if (shouldFlipStatus) {
        task.result.state = 'pass'
      }
    }

    const isRetryReasonAtr = numAttempt > 0 &&
      isFlakyTestRetriesEnabledForTask(providedContext, task) &&
      !attemptToFixRetryTasks.has(task) &&
      !efdRetryTasks.has(task)

    const ctx = {
      testName,
      testSuiteAbsolutePath: task.file.filepath,
      isRetry: numAttempt > 0 || numRepetition > 0,
      isRetryReasonEfd: efdRetryTasks.has(task),
      isRetryReasonAttemptToFix: attemptToFixRetryTasks.has(task) && numRepetition > 0,
      isNew,
      hasDynamicName: dynamicNameTasks.has(task),
      mightHitProbe: isDiEnabled && isFailedTestReplayAllowed && numAttempt > 0,
      isAttemptToFix: attemptToFixTasks.has(task),
      isDisabled: disabledTasks.has(task),
      isQuarantined: quarantinedTasks.has(task),
      isRetryReasonAtr,
      isModified: modifiedTasks.has(task),
    }
    taskToCtx.set(task, ctx)

    if (attemptToFixTasks.has(task)) {
      logAttemptToFixTestExecution(
        getTaskTestSuite(task),
        testName,
        loggedAttemptToFixTests
      )
    }

    testStartCh.runStores(ctx, () => {})

    // Wrap the test function so it runs inside the test span context.
    // Without this, HTTP requests during test execution become orphaned root spans.
    if (vitestGetFn && vitestSetFn) {
      const originalFn = vitestGetFn(task)
      if (originalFn && !originalFn.__ddTraceWrapped) {
        const wrappedFn = wrapTestScopedFn(task, originalFn)
        wrappedFn.__ddTraceWrapped = true
        vitestSetFn(task, wrappedFn)
      }
    }

    // Wrap beforeEach/afterEach hooks so they also run inside the test span context.
    // In vitest 4+, hooks are in a WeakMap accessed via getHooks(). In older versions, they're on suite.hooks.
    let currentSuite = task.suite
    while (currentSuite) {
      const hooks = vitestGetHooks ? vitestGetHooks(currentSuite) : currentSuite.hooks
      if (hooks) {
        for (const hookType of ['beforeEach', 'afterEach']) {
          const hookArray = hooks[hookType]
          if (!hookArray) continue
          for (let i = 0; i < hookArray.length; i++) {
            const currentFn = hookArray[i]
            if (originalHookFns.has(currentFn)) continue
            const wrappedFn = wrapSuiteHookFn(hookType, currentFn, task)
            originalHookFns.set(wrappedFn, currentFn)
            hookArray[i] = wrappedFn
          }
        }
      }
      currentSuite = currentSuite.suite
    }

    return onBeforeTryTask.apply(this, arguments)
  })

  // test finish (only passed tests)
  shimmer.wrap(VitestTestRunner.prototype, 'onAfterTryTask', onAfterTryTask =>
    async function (task, retryInfo) {
      if (!testPassCh.hasSubscribers && !testErrorCh.hasSubscribers && !testSkipCh.hasSubscribers) {
        return onAfterTryTask.apply(this, arguments)
      }
      const result = await onAfterTryTask.apply(this, arguments)

      const {
        testManagementAttemptToFixRetries,
        earlyFlakeDetectionRetryPolicy,
      } = getProvidedContext()

      const status = getVitestTestStatus(task, retryInfo.retry)
      const ctx = taskToCtx.get(task)

      const { isDiEnabled } = getProvidedContext()
      const isFailedTestReplayAllowed = !hasConcurrentTests(task.file)

      if (efdSkippedRetryResults.has(task)) {
        task.result = efdSkippedRetryResults.get(task)
        efdSkippedRetryResults.delete(task)
        return result
      }

      if (isDiEnabled && isFailedTestReplayAllowed && retryInfo.retry > 1) {
        await waitForHitProbe()
      }

      if (
        efdRetryTasks.has(task) &&
        (retryInfo.repeats ?? 0) === 0 &&
        !efdDeterminedRetries.has(task)
      ) {
        const executionStart = efdExecutionStartByTask.get(task)
        const duration = executionStart === undefined ? task.result?.duration ?? 0 : performance.now() - executionStart
        const retryCount = getEfdRetryCountForDuration(duration, earlyFlakeDetectionRetryPolicy)
        efdDeterminedRetries.set(task, retryCount)
        task.repeats = retryCount
        if (retryCount === 0) {
          efdSlowAbortedTasks.add(task)
        }
      }

      let attemptToFixPassed = false
      let attemptToFixFailed = false
      if (attemptToFixTasks.has(task)) {
        const statuses = attemptToFixTaskToStatuses.get(task)
        if (statuses.length === testManagementAttemptToFixRetries) {
          if (status === 'pass' && statuses.every(status => status === 'pass')) {
            attemptToFixPassed = true
          } else if (status === 'fail' || statuses.includes('fail')) {
            attemptToFixFailed = true
          }
        }
      }

      if (ctx) {
        // We don't finish here because the test might fail in a later hook (afterEach)
        ctx.status = status
        ctx.task = task
        ctx.attemptToFixPassed = attemptToFixPassed
        ctx.attemptToFixFailed = attemptToFixFailed
        testFinishTimeCh.runStores(ctx, () => {})
      }

      return result
    })
}

function captureRunnerFunctions (pkg) {
  const getFnExport = findExportByName(pkg, 'getFn')
  const setFnExport = findExportByName(pkg, 'setFn')
  if (!vitestGetFn && getFnExport) {
    vitestGetFn = getFnExport.value
  }
  if (!vitestSetFn && setFnExport) {
    vitestSetFn = setFnExport.value
  }
  const getHooksExport = findExportByName(pkg, 'getHooks')
  if (!vitestGetHooks && getHooksExport) {
    vitestGetHooks = getHooksExport.value
  }
}

function installTestScopedRunTask (VitestTestRunner) {
  if (VitestTestRunner.prototype.runTask) return

  VitestTestRunner.prototype.runTask = function (task) {
    const fn = vitestGetFn?.(task)
    if (!fn) {
      throw new Error('Test function is not found. Did you add it using setFn?')
    }
    const testFn = wrapTestScopedFn(task, fn)
    return testFn()
  }
}

addHook({
  name: 'vitest',
  versions: ['>=4.0.0 <5.0.0'],
  filePattern: 'dist/chunks/test.*',
}, (testPackage) => {
  const testRunner = getTestRunnerExport(testPackage)
  if (!testRunner) {
    return testPackage
  }

  captureRunnerFunctions(testPackage)
  wrapVitestTestRunner(testRunner.value)

  return testPackage
})

// Vitest 5 bundled the former @vitest/runner implementation into separate index and run chunks.
addHook({
  name: 'vitest',
  versions: ['>=5.0.0'],
  filePattern: 'dist/chunks/index.*',
}, (testPackage) => {
  const testRunner = getTestRunnerExport(testPackage)
  if (testRunner) {
    wrapVitestTestRunner(testRunner.value)
    installTestScopedRunTask(testRunner.value)
  }
  return testPackage
})

addHook({
  name: 'vitest',
  versions: ['>=5.0.0'],
  filePattern: 'dist/chunks/run.*',
}, (runnerPackage, frameworkVersion) => {
  captureRunnerFunctions(runnerPackage)
  wrapStartTests(runnerPackage, frameworkVersion)
  return runnerPackage
})

addHook({
  name: '@vitest/runner',
  versions: ['>=1.6.0'],
}, (runnerModule) => {
  if (!vitestGetFn && runnerModule.getFn && runnerModule.setFn) {
    vitestGetFn = runnerModule.getFn
    vitestSetFn = runnerModule.setFn
  }
  if (!vitestGetHooks && runnerModule.getHooks) {
    vitestGetHooks = runnerModule.getHooks
  }
  return runnerModule
})

addHook({
  name: 'vitest',
  versions: ['>=1.6.0 <4.0.0'],
  file: 'dist/runners.js',
}, (vitestPackage) => {
  const { VitestTestRunner } = vitestPackage

  wrapVitestTestRunner(VitestTestRunner)

  return vitestPackage
})

function getStartTestsWrapper (frameworkVersion) {
  return startTests => async function (testPaths) {
    let testSuiteError = null
    if (!testSuiteFinishCh.hasSubscribers) {
      return startTests.apply(this, arguments)
    }
    const runner = arguments[1]
    // Vitest 3+ exposes the only awaited worker-shutdown boundary; older versions keep timer/before-exit behavior.
    if (logSubmissionFlushCh.hasSubscribers &&
        typeof runner?.onCleanupWorkerContext === 'function' &&
        !runnersWithLogSubmissionCleanup.has(runner)) {
      runnersWithLogSubmissionCleanup.add(runner)
      runner.onCleanupWorkerContext(() => getChannelPromise(logSubmissionFlushCh))
    }
    // From >=3.0.1, the first arguments changes from a string to an object containing the filepath
    const testSuiteAbsolutePath = testPaths[0]?.filepath || testPaths[0]
    const providedContext = getProvidedContext()
    const repositoryRoot = providedContext.repositoryRoot || process.cwd()
    const testSuite = getTestSuitePath(testSuiteAbsolutePath, repositoryRoot)
    const coverageOptions = getVitestCoverageOptions()
    const shouldUseVitestCoverage = usesVitestV8CoverageSnapshot(coverageOptions)
    const coverageLibrary = 'v8'
    vitestCoverageSnapshot = undefined
    if (providedContext.isCodeCoverageEnabled) {
      if (shouldUseVitestCoverage) {
        wrapVitestCoverageRpc()
      } else {
        await startPreciseCoverage()
      }
    }

    const testSuiteCtx = {
      testSuiteAbsolutePath,
      frameworkVersion,
      testSessionId: providedContext.testSessionId,
      testModuleId: providedContext.testModuleId,
      testCommand: providedContext.testCommand,
      repositoryRoot,
      codeOwnersEntries: providedContext.codeOwnersEntries,
      isCodeCoverageEnabled: providedContext.isCodeCoverageEnabled,
      coverageLibrary,
      itrCorrelationId: providedContext.itrCorrelationId,
      isUnskippable: providedContext.unskippableSuites?.[testSuite] === true,
      isForcedToRun: providedContext.forcedToRunSuites?.[testSuite] === true,
    }
    testSuiteStartCh.runStores(testSuiteCtx, () => {})
    const startTestsResponse = await startTests.apply(this, arguments)

    const testTasks = getTypeTasks(startTestsResponse[0].tasks)
    const testEventPromises = []

    // Only one test task per test, even if there are retries
    for (const task of testTasks) {
      const testCtx = taskToCtx.get(task)
      const { result } = task
      // We have to trick vitest into thinking that the test has passed
      // but we want to report it as failed if it did fail
      const switchedStatus = switchedStatuses.get(task)
      const isSwitchedStatus = switchedStatus !== undefined

      if (result) {
        const { state, duration, errors } = result
        const testError = getCurrentAttemptTestError(task, errors)
        if (attemptToFixTasks.has(task)) {
          const attemptToFixStatus = getFinalAttemptToFixStatus(task, state, isSwitchedStatus, testCtx)
          recordFinalAttemptToFixExecution(task, attemptToFixStatus, providedContext)
        }

        if (state === 'skip') { // programmatic skip
          testSkipCh.publish({
            testName: getTestName(task),
            testSuiteAbsolutePath: task.file.filepath,
            isNew: newTasks.has(task),
            isAttemptToFix: attemptToFixTasks.has(task),
            isDisabled: disabledTasks.has(task),
            isQuarantined: quarantinedTasks.has(task),
          })
        } else if (state === 'pass' && !isSwitchedStatus) {
          if (testCtx) {
            const isSkippedByTestManagement =
              !attemptToFixTasks.has(task) && (disabledTasks.has(task) || quarantinedTasks.has(task))
            const promises = {}
            testPassCh.publish({
              task,
              finalStatus: isSkippedByTestManagement ? 'skip' : 'pass',
              earlyFlakeAbortReason: efdSlowAbortedTasks.has(task) ? 'slow' : undefined,
              promises,
              ...testCtx.currentStore,
            })
            if (promises.hitBreakpointPromise) {
              testEventPromises.push(promises.hitBreakpointPromise)
            }
          }
        } else if (state === 'fail' || isSwitchedStatus) {
          let hasFailedAllRetries = false
          let attemptToFixFailed = false
          if (attemptToFixTasks.has(task)) {
            const statuses = attemptToFixTaskToStatuses.get(task)
            if (statuses.includes('fail')) {
              attemptToFixFailed = true
            }
            if (statuses.every(status => status === 'fail')) {
              hasFailedAllRetries = true
            }
          }

          // Check if all EFD retries failed
          const isEfdRetry = efdRetryTasks.has(task)
          if (isEfdRetry) {
            const statuses = taskToStatuses.get(task)
            const efdRetryCount = efdDeterminedRetries.get(task) ??
              providedContext.earlyFlakeDetectionRetryPolicy.schedulingRetryCount
            // statuses only includes repetitions (not the initial run), so we check against retry count (not +1)
            if (efdRetryCount > 0 && statuses && statuses.length === efdRetryCount &&
              statuses.every(status => status === 'fail')) {
              hasFailedAllRetries = true
            }
          }

          // ATR: set hasFailedAllRetries when all auto test retries were exhausted and every attempt failed
          const isAtrRetry = isFlakyTestRetriesEnabledForTask(providedContext, task) && !attemptToFixTasks.has(task) &&
            !newTasks.has(task) && !modifiedTasks.has(task)
          if (isAtrRetry) {
            const maxRetries = providedContext.flakyTestRetriesCount ?? 0
            if (maxRetries > 0 && task.result?.retryCount === maxRetries) {
              hasFailedAllRetries = true
            }
          }

          if (testCtx) {
            const isRetry = task.result?.retryCount > 0
            const promises = {}
            // `duration` is the duration of all the retries, so it can't be used if there are retries

            let finalStatus
            if (isSwitchedStatus) {
              if (!attemptToFixTasks.has(task) && (disabledTasks.has(task) || quarantinedTasks.has(task))) {
                finalStatus = 'skip'
              } else if (isAtrRetry || isEfdRetry) {
                finalStatus = hasFailedAllRetries ? 'fail' : 'pass'
              } else if (attemptToFixTasks.has(task)) {
                finalStatus = attemptToFixFailed ? 'fail' : 'pass'
              } else {
                finalStatus = undefined
              }
            } else {
              finalStatus = 'fail'
            }

            testErrorCh.publish({
              duration: isRetry ? undefined : duration,
              error: testError,
              hasFailedAllRetries,
              attemptToFixFailed,
              finalStatus,
              earlyFlakeAbortReason: efdSlowAbortedTasks.has(task) ? 'slow' : undefined,
              promises,
              ...testCtx.currentStore,
            })
            if (promises.hitBreakpointPromise) {
              testEventPromises.push(promises.hitBreakpointPromise)
            }
          }
          if (errors?.length) {
            testSuiteError = testError // we store the error to bubble it up to the suite
          }
        }
      } else { // test.skip or test.todo
        testSkipCh.publish({
          testName: getTestName(task),
          testSuiteAbsolutePath: task.file.filepath,
          isNew: newTasks.has(task),
          isAttemptToFix: attemptToFixTasks.has(task),
          isDisabled: disabledTasks.has(task),
          isQuarantined: quarantinedTasks.has(task),
        })
      }
    }

    await Promise.all(testEventPromises)

    const testSuiteResult = startTestsResponse[0].result

    if (testSuiteResult.errors?.length) { // Errors from root level hooks
      testSuiteError = testSuiteResult.errors[0]
    } else if (testSuiteResult.state === 'fail') { // Errors from `describe` level hooks
      const suiteTasks = getTypeTasks(startTestsResponse[0].tasks, 'suite')
      const failedSuites = suiteTasks.filter(task => task.result?.state === 'fail')
      if (failedSuites.length && failedSuites[0].result?.errors?.length) {
        testSuiteError = failedSuites[0].result.errors[0]
      }
    }

    if (testSuiteError) {
      testSuiteCtx.error = testSuiteError
      testSuiteErrorCh.runStores(testSuiteCtx, () => {})
    }

    let coverageFiles
    if (providedContext.isCodeCoverageEnabled) {
      const currentCoverageFiles = shouldUseVitestCoverage
        ? getVitestCoverageFiles(repositoryRoot)
        : await getPreciseCoverageFiles(repositoryRoot)
      coverageFiles = includePreviouslyCoveredFiles(currentCoverageFiles)
    }

    await getChannelPromise(testSuiteFinishCh, {
      status: testSuiteResult.state,
      coverageFiles,
      coverageLibrary,
      testSuiteAbsolutePath,
      ...testSuiteCtx.currentStore,
    })

    return startTestsResponse
  }
}

function wrapStartTests (vitestPackage, frameworkVersion) {
  const startTests = findExportByName(vitestPackage, 'startTests')
  if (startTests) {
    shimmer.wrap(vitestPackage, startTests.key, getStartTestsWrapper(frameworkVersion))
  }
  return vitestPackage
}

// test suite start and finish
// only relevant for workers
addHook({
  name: '@vitest/runner',
  versions: ['>=1.6.0'],
}, wrapStartTests)
