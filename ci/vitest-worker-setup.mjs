import { realpathSync } from 'node:fs'
import { relative } from 'node:path'
import { performance } from 'node:perf_hooks'

import * as vitestRunner from '@vitest/runner'
import { afterEach, beforeAll, beforeEach, onTestFinished } from 'vitest'

const providedContext = getProvidedContext()
const attemptToFixTests = providedContext.attemptToFixTests || {}
const attemptToFixRetries = providedContext.attemptToFixRetries || 0
const disabledTests = providedContext.disabledTests || {}
const earlyFlakeDetectionRetries = providedContext.earlyFlakeDetectionRetries || 0
const earlyFlakeDetectionSlowRetries = providedContext.earlyFlakeDetectionSlowRetries || {}
const earlyFlakeDetectionRetryThresholds = [
  { limitMs: 5 * 1000, key: '5s' },
  { limitMs: 10 * 1000, key: '10s' },
  { limitMs: 30 * 1000, key: '30s' },
  { limitMs: 5 * 60 * 1000, key: '5m' },
]
const hasEarlyFlakeDetectionSlowRetries = Object.keys(earlyFlakeDetectionSlowRetries).length > 0
const isEarlyFlakeDetectionEnabled = providedContext.isEarlyFlakeDetectionEnabled === true
const knownTests = providedContext.knownTests || {}
const modifiedFiles = providedContext.modifiedFiles || {}
const repositoryRoot = realpath(providedContext.repositoryRoot || process.cwd())
const setVitestTaskFn = vitestRunner.setFn
const earlyFlakeDetectionRetriesByTask = new WeakMap()
const earlyFlakeDetectionSkippedResults = new WeakMap()
const earlyFlakeDetectionStartByTask = new WeakMap()
const nextAttemptIndexByTask = new WeakMap()
const realpaths = new Map()

// eslint-disable-next-line no-empty-pattern
beforeAll(function ({}, suite) {
  suite ||= arguments[0]
  applyExecutionChanges(suite)
})

beforeEach(function ({ task, skip }) {
  const testSuite = getTestSuite(task)
  const testName = getTestName(task)
  const attemptIndex = getNextAttemptIndex(task)
  if (attemptIndex > 0) {
    recordTestOptimizationStatus(task, attemptIndex - 1)
  }

  if (disabledTests[testSuite]?.[testName]) {
    skip('Skipped by Datadog Test Optimization')
  } else if (attemptToFixTests[testSuite]?.[testName] && attemptIndex > 0) {
    task.result.state = 'run'
  } else if (isEarlyFlakeDetectionTest(testSuite, testName)) {
    const isSkippedRepeat = prepareEarlyFlakeDetectionAttempt(task, attemptIndex)
    if (!isSkippedRepeat && attemptIndex > 0) {
      task.result.state = 'run'
    }
  }

  if (attemptToFixTests[testSuite]?.[testName] || isEarlyFlakeDetectionTest(testSuite, testName)) {
    onTestFinished(() => {
      if (attemptIndex === getFinalAttemptIndex(task)) {
        recordTestOptimizationStatus(task, attemptIndex, true)
      }
    })
  }
})

afterEach(function ({ task }) {
  const attemptIndex = task.meta.__ddTestOptCurrentAttemptIndex
  if (attemptIndex === getFinalAttemptIndex(task)) {
    recordTestOptimizationStatus(task, attemptIndex)
  }
})

function applyExecutionChanges (suite) {
  for (const task of suite?.tasks || []) {
    if (task.type === 'suite') {
      applyExecutionChanges(task)
      continue
    }

    const testSuite = getTestSuite(task)
    const testName = getTestName(task)
    if (attemptToFixTests[testSuite]?.[testName]) {
      task.retry = 0
      task.repeats = attemptToFixRetries
      task.meta.__ddTestOptAtfRetries = attemptToFixRetries
    } else if (isEarlyFlakeDetectionTest(testSuite, testName)) {
      task.retry = 0
      task.repeats = earlyFlakeDetectionRetries
      task.meta.__ddTestOptEfdRetries = earlyFlakeDetectionRetries
    }
  }
}

function getNextAttemptIndex (task) {
  const attemptIndex = nextAttemptIndexByTask.get(task) || 0
  nextAttemptIndexByTask.set(task, attemptIndex + 1)
  task.meta.__ddTestOptCurrentAttemptIndex = attemptIndex
  return attemptIndex
}

function recordTestOptimizationStatus (task, attemptIndex = task.result?.repeatCount || 0, onlyIfNewErrors = false) {
  const testSuite = getTestSuite(task)
  const testName = getTestName(task)

  if (attemptToFixTests[testSuite]?.[testName]) {
    recordAttemptToFixStatus(task, attemptIndex, onlyIfNewErrors)
  } else if (isEarlyFlakeDetectionTest(testSuite, testName)) {
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
  if (task.meta.__ddTestOptEfdSkipCurrentAttempt) {
    delete task.meta.__ddTestOptEfdSkipCurrentAttempt
    const skippedResult = earlyFlakeDetectionSkippedResults.get(task)
    if (skippedResult) {
      task.result = skippedResult
      earlyFlakeDetectionSkippedResults.delete(task)
    }
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
    if (retryCount === 0 && hasEarlyFlakeDetectionSlowRetries) {
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
  if (isEarlyFlakeDetectionTest(testSuite, testName)) {
    return getEarlyFlakeDetectionRetryCountForTask(task)
  }
  return task.repeats
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
    earlyFlakeDetectionStartByTask.set(task, performance.now())
    return false
  }

  let retryCount = earlyFlakeDetectionRetriesByTask.get(task)
  if (retryCount === undefined) {
    retryCount = getEarlyFlakeDetectionRetryCount(task)
    earlyFlakeDetectionRetriesByTask.set(task, retryCount)
    task.repeats = retryCount
    task.meta.__ddTestOptEfdRetries = retryCount
    if (retryCount === 0 && hasEarlyFlakeDetectionSlowRetries) {
      task.meta.__ddTestOptEfdAbortReason = 'slow'
    }
  }

  if (attemptIndex <= retryCount || typeof setVitestTaskFn !== 'function') {
    earlyFlakeDetectionStartByTask.set(task, performance.now())
    return false
  }

  if (task.result) {
    earlyFlakeDetectionSkippedResults.set(task, {
      ...task.result,
      errors: task.result.errors?.slice(),
    })
  }
  task.meta.__ddTestOptEfdSkipCurrentAttempt = true
  setVitestTaskFn(task, noopTest)
  return true
}

function getEarlyFlakeDetectionRetryCount (task) {
  if (!hasEarlyFlakeDetectionSlowRetries) {
    return earlyFlakeDetectionRetries
  }

  const executionStart = earlyFlakeDetectionStartByTask.get(task)
  const duration = executionStart === undefined ? task.result?.duration ?? 0 : performance.now() - executionStart
  for (const { key, limitMs } of earlyFlakeDetectionRetryThresholds) {
    if (duration < limitMs) {
      return earlyFlakeDetectionSlowRetries[key] ?? 0
    }
  }
  return 0
}

function noopTest () {}

function isEarlyFlakeDetectionTest (testSuite, testName) {
  if (!isEarlyFlakeDetectionEnabled || earlyFlakeDetectionRetries <= 0) return false
  if (isModifiedTest(testSuite)) return true
  const testsForSuite = knownTests[testSuite] || []
  return !testsForSuite.includes(testName)
}

function isModifiedTest (testSuite) {
  return modifiedFiles[testSuite]?.length > 0
}

function getTestSuite (task) {
  let filepath = realpaths.get(task.file.filepath)
  if (filepath === undefined) {
    filepath = realpath(task.file.filepath)
    realpaths.set(task.file.filepath, filepath)
  }

  return normalizePath(relative(repositoryRoot, filepath))
}

function realpath (filepath) {
  try {
    return realpathSync(filepath)
  } catch {
    return filepath
  }
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

function getProvidedContext () {
  try {
    return globalThis.__vitest_worker__.providedContext._ddVitestWorkerSetup || {}
  } catch {
    return {}
  }
}
