'use strict'

// Capture real timers at module load time, before any test can install fake timers.
const realSetTimeout = setTimeout

const { performance } = require('node:perf_hooks')

const shimmer = require('../../datadog-shimmer')
const {
  DYNAMIC_NAME_RE,
  getEfdRetryCount,
  recordAttemptToFixExecution,
  logAttemptToFixTestExecution,
} = require('../../dd-trace/src/plugins/util/test')
const { addHook } = require('./helpers/instrument')
const {
  testStartCh,
  testFinishTimeCh,
  testPassCh,
  testErrorCh,
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
  isFlakyTestRetriesEnabledForTask,
  getVitestTestProperties,
} = require('./vitest-util')

const BREAKPOINT_HIT_GRACE_PERIOD_MS = 400

const taskToCtx = new WeakMap()
const taskToTestProperties = new WeakMap()
const taskToStatuses = new WeakMap()
const taskToReportedErrorCount = new WeakMap()
const attemptToFixTaskToStatuses = new WeakMap()
const originalHookFns = new WeakMap()
const newTasks = new WeakSet()
const dynamicNameTasks = new WeakSet()
const disabledTasks = new WeakSet()
const quarantinedTasks = new WeakSet()
const attemptToFixTasks = new WeakSet()
const modifiedTasks = new WeakSet()
const efdDeterminedRetries = new WeakMap()
const efdSlowAbortedTasks = new WeakSet()
const efdExecutionStartByTask = new WeakMap()
const efdSkippedRetryResults = new WeakMap()
const attemptToFixExecutions = new Map()
const loggedAttemptToFixTests = new Set()
let isRetryReasonEfd = false
let isRetryReasonAttemptToFix = false
const switchedStatuses = new WeakSet()
let vitestGetFn = null
let vitestSetFn = null
let vitestGetHooks = null

function waitForHitProbe () {
  return new Promise(resolve => {
    realSetTimeout(() => {
      resolve()
    }, BREAKPOINT_HIT_GRACE_PERIOD_MS)
  })
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

function wrapVitestTestRunner (VitestTestRunner) {
  // `onBeforeRunTask` is run before any repetition or attempt is run
  // `onBeforeRunTask` is an async function
  shimmer.wrap(VitestTestRunner.prototype, 'onBeforeRunTask', onBeforeRunTask => function (task) {
    const testName = getTestName(task)

    const providedContext = getProvidedContext()
    const {
      isEarlyFlakeDetectionEnabled,
      isKnownTestsEnabled,
      numRepeats,
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
        isRetryReasonAttemptToFix = task.repeats !== testManagementAttemptToFixRetries
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
      if (isEarlyFlakeDetectionEnabled) {
        isRetryReasonEfd = true
        disableFrameworkRetries(task)
        task.repeats = numRepeats
      }
      modifiedTasks.add(task)
      taskToStatuses.set(task, [])
    }

    if (isKnownTestsEnabled && testProperties.isNew && !attemptToFixTasks.has(task)) {
      if (isEarlyFlakeDetectionEnabled && !modifiedTasks.has(task)) {
        isRetryReasonEfd = true
        disableFrameworkRetries(task)
        task.repeats = numRepeats
      }
      newTasks.add(task)
      taskToStatuses.set(task, [])
      if (DYNAMIC_NAME_RE.test(testName)) {
        dynamicNameTasks.add(task)
      }
    }

    return onBeforeRunTask.apply(this, arguments)
  })

  // `onAfterRunTask` is run after all repetitions or attempts are run
  // `onAfterRunTask` is an async function
  shimmer.wrap(VitestTestRunner.prototype, 'onAfterRunTask', onAfterRunTask => function (task) {
    const { isEarlyFlakeDetectionEnabled, isTestManagementTestsEnabled } = getProvidedContext()

    if (isTestManagementTestsEnabled) {
      const isAttemptingToFix = attemptToFixTasks.has(task)
      const isQuarantined = quarantinedTasks.has(task)

      if (isAttemptingToFix) {
        const statuses = attemptToFixTaskToStatuses.get(task)
        if (task.result.state === 'pass' && statuses?.includes('fail')) {
          switchedStatuses.add(task)
          task.result.state = 'fail'
        }
      }

      if (!isAttemptingToFix && isQuarantined) {
        if (task.result.state === 'fail') {
          switchedStatuses.add(task)
        }
        task.result.state = 'pass'
      }
    }

    if (isEarlyFlakeDetectionEnabled && taskToStatuses.has(task) && !attemptToFixTasks.has(task)) {
      const statuses = taskToStatuses.get(task)
      // If the test has passed at least once, we consider it passed
      if (statuses.includes('pass')) {
        if (task.result.state === 'fail') {
          switchedStatuses.add(task)
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
      isEarlyFlakeDetectionEnabled,
      isDiEnabled,
      slowTestRetries,
    } = providedContext

    if (isKnownTestsEnabled) {
      isNew = newTasks.has(task)
    }

    const { retry: numAttempt, repeats: numRepetition } = retryInfo
    const isEfdManagedTask = isEarlyFlakeDetectionEnabled && taskToStatuses.has(task) && !attemptToFixTasks.has(task)

    if (isEfdManagedTask && numRepetition > 0 && !efdDeterminedRetries.has(task)) {
      const previousExecutionStart = efdExecutionStartByTask.get(task)
      const duration = previousExecutionStart === undefined
        ? task.result?.duration ?? 0
        : performance.now() - previousExecutionStart
      const retryCount = getEfdRetryCount(duration, slowTestRetries)
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
      const shouldWaitForHitProbe = isDiEnabled && numAttempt > 1
      if (shouldWaitForHitProbe) {
        await waitForHitProbe()
      }

      const promises = {}
      const shouldSetProbe = isDiEnabled && numAttempt === 1
      const ctx = taskToCtx.get(task)
      const testError = getCurrentAttemptTestError(task, task.result?.errors)
      if (ctx) {
        testErrorCh.publish({
          error: testError,
          shouldSetProbe,
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
    const shouldTrackStatuses = isEarlyFlakeDetectionEnabled || isAtf
    const shouldFlipStatus = isEarlyFlakeDetectionEnabled || isAtf
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
      !isRetryReasonAttemptToFix &&
      !isRetryReasonEfd

    const ctx = {
      testName,
      testSuiteAbsolutePath: task.file.filepath,
      isRetry: numAttempt > 0 || numRepetition > 0,
      isRetryReasonEfd,
      isRetryReasonAttemptToFix: isRetryReasonAttemptToFix && numRepetition > 0,
      isNew,
      hasDynamicName: dynamicNameTasks.has(task),
      mightHitProbe: isDiEnabled && numAttempt > 0,
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
            const originalFn = originalHookFns.get(currentFn) || currentFn
            const wrappedFn = shimmer.wrapFunction(originalFn, fn => function (...args) {
              const result = testFnCh.runStores(taskToCtx.get(task), () => fn.apply(this, args))

              if (hookType === 'beforeEach') {
                return wrapBeforeEachCleanupResult(task, result)
              }

              return result
            })
            originalHookFns.set(wrappedFn, originalFn)
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
        isEarlyFlakeDetectionEnabled,
        testManagementAttemptToFixRetries,
        slowTestRetries,
      } = getProvidedContext()

      const status = getVitestTestStatus(task, retryInfo.retry)
      const ctx = taskToCtx.get(task)

      const { isDiEnabled } = getProvidedContext()

      if (efdSkippedRetryResults.has(task)) {
        task.result = efdSkippedRetryResults.get(task)
        efdSkippedRetryResults.delete(task)
        return result
      }

      if (isDiEnabled && retryInfo.retry > 1) {
        await waitForHitProbe()
      }

      if (
        isEarlyFlakeDetectionEnabled &&
        (retryInfo.repeats ?? 0) === 0 &&
        taskToStatuses.has(task) &&
        !attemptToFixTasks.has(task) &&
        !efdDeterminedRetries.has(task)
      ) {
        const executionStart = efdExecutionStartByTask.get(task)
        const duration = executionStart === undefined ? task.result?.duration ?? 0 : performance.now() - executionStart
        const retryCount = getEfdRetryCount(duration, slowTestRetries)
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
  if (vitestGetFn) return
  const getFnExport = findExportByName(pkg, 'getFn')
  const setFnExport = findExportByName(pkg, 'setFn')
  if (getFnExport && setFnExport) {
    vitestGetFn = getFnExport.value
    vitestSetFn = setFnExport.value
  }
  const getHooksExport = findExportByName(pkg, 'getHooks')
  if (getHooksExport) {
    vitestGetHooks = getHooksExport.value
  }
}

addHook({
  name: 'vitest',
  versions: ['>=4.0.0'],
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

// test suite start and finish
// only relevant for workers
addHook({
  name: '@vitest/runner',
  versions: ['>=1.6.0'],
}, (vitestPackage, frameworkVersion) => {
  shimmer.wrap(vitestPackage, 'startTests', startTests => async function (testPaths) {
    let testSuiteError = null
    if (!testSuiteFinishCh.hasSubscribers) {
      return startTests.apply(this, arguments)
    }
    // From >=3.0.1, the first arguments changes from a string to an object containing the filepath
    const testSuiteAbsolutePath = testPaths[0]?.filepath || testPaths[0]
    const providedContext = getProvidedContext()

    const testSuiteCtx = {
      testSuiteAbsolutePath,
      frameworkVersion,
      testSessionId: providedContext.testSessionId,
      testModuleId: providedContext.testModuleId,
      testCommand: providedContext.testCommand,
      repositoryRoot: providedContext.repositoryRoot,
      codeOwnersEntries: providedContext.codeOwnersEntries,
    }
    testSuiteStartCh.runStores(testSuiteCtx, () => {})
    const startTestsResponse = await startTests.apply(this, arguments)

    let onFinish = null
    const onFinishPromise = new Promise(resolve => {
      onFinish = resolve
    })

    const testTasks = getTypeTasks(startTestsResponse[0].tasks)

    // Only one test task per test, even if there are retries
    for (const task of testTasks) {
      const testCtx = taskToCtx.get(task)
      const { result } = task
      // We have to trick vitest into thinking that the test has passed
      // but we want to report it as failed if it did fail
      const isSwitchedStatus = switchedStatuses.has(task)

      if (result) {
        const { state, duration, errors } = result
        const testError = getCurrentAttemptTestError(task, errors)
        if (attemptToFixTasks.has(task)) {
          const status = getFinalAttemptToFixStatus(task, state, isSwitchedStatus, testCtx)
          recordFinalAttemptToFixExecution(task, status, providedContext)
        }

        if (state === 'skip') { // programmatic skip
          testSkipCh.publish({
            testName: getTestName(task),
            testSuiteAbsolutePath: task.file.filepath,
            isNew: newTasks.has(task),
            isDisabled: disabledTasks.has(task),
          })
        } else if (state === 'pass' && !isSwitchedStatus) {
          if (testCtx) {
            const isSkippedByTestManagement =
              !attemptToFixTasks.has(task) && (disabledTasks.has(task) || quarantinedTasks.has(task))
            testPassCh.publish({
              task,
              finalStatus: isSkippedByTestManagement ? 'skip' : 'pass',
              earlyFlakeAbortReason: efdSlowAbortedTasks.has(task) ? 'slow' : undefined,
              ...testCtx.currentStore,
            })
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
          const isEfdRetry =
            providedContext.isEarlyFlakeDetectionEnabled && (newTasks.has(task) || modifiedTasks.has(task))
          if (isEfdRetry) {
            const statuses = taskToStatuses.get(task)
            const efdRetryCount = efdDeterminedRetries.get(task) ?? providedContext.numRepeats
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
              ...testCtx.currentStore,
            })
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
          isDisabled: disabledTasks.has(task),
        })
      }
    }

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

    testSuiteFinishCh.publish({ status: testSuiteResult.state, onFinish, ...testSuiteCtx.currentStore })

    await onFinishPromise

    return startTestsResponse
  })

  return vitestPackage
})
