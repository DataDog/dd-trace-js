const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')

// test hooks
const testStartCh = channel('ci:vitest:test:start')
const testFinishTimeCh = channel('ci:vitest:test:finish-time')
const testPassCh = channel('ci:vitest:test:pass')
const testErrorCh = channel('ci:vitest:test:error')
const testSkipCh = channel('ci:vitest:test:skip')

// test suite hooks
const testSuiteStartCh = channel('ci:vitest:test-suite:start')
const testSuiteFinishCh = channel('ci:vitest:test-suite:finish')
const testSuiteErrorCh = channel('ci:vitest:test-suite:error')

// test session hooks
const testSessionStartCh = channel('ci:vitest:session:start')
const testSessionFinishCh = channel('ci:vitest:session:finish')
const libraryConfigurationCh = channel('ci:vitest:library-configuration')
const knownTestsCh = channel('ci:vitest:known-tests')

const taskToAsync = new WeakMap()
const taskToStatuses = new WeakMap()
const newTasks = new WeakSet()
const sessionAsyncResource = new AsyncResource('bound-anonymous-fn')

function isReporterPackage (vitestPackage) {
  return vitestPackage.B?.name === 'BaseSequencer'
}

// from 2.0.0
function isReporterPackageNew (vitestPackage) {
  return vitestPackage.e?.name === 'BaseSequencer'
}

function isReporterPackageNewest (vitestPackage) {
  return vitestPackage.h?.name === 'BaseSequencer'
}

function getChannelPromise (channelToPublishTo) {
  return new Promise(resolve => {
    sessionAsyncResource.runInAsyncScope(() => {
      channelToPublishTo.publish({ onDone: resolve })
    })
  })
}

function getSessionStatus (state) {
  if (state.getCountOfFailedTests() > 0) {
    return 'fail'
  }
  if (state.pathsSet.size === 0) {
    return 'skip'
  }
  return 'pass'
}

// eslint-disable-next-line
// From https://github.com/vitest-dev/vitest/blob/51c04e2f44d91322b334f8ccbcdb368facc3f8ec/packages/runner/src/run.ts#L243-L250
function getVitestTestStatus (test, retryCount) {
  if (test.result.state !== 'fail') {
    if (!test.repeats) {
      return 'pass'
    } else if (test.repeats && (test.retry ?? 0) === retryCount) {
      return 'pass'
    }
  }
  return 'fail'
}

function getTypeTasks (fileTasks, type = 'test') {
  const typeTasks = []

  function getTasks (tasks) {
    for (const task of tasks) {
      if (task.type === type) {
        typeTasks.push(task)
      } else if (task.tasks) {
        getTasks(task.tasks)
      }
    }
  }

  getTasks(fileTasks)

  return typeTasks
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

function getSortWrapper (sort) {
  return async function () {
    if (!testSessionFinishCh.hasSubscribers) {
      return sort.apply(this, arguments)
    }
    // There isn't any other async function that we seem to be able to hook into
    // So we will use the sort from BaseSequencer. This means that a custom sequencer
    // will not work. This will be a known limitation.
    let isFlakyTestRetriesEnabled = false
    let flakyTestRetriesCount = 0
    let isEarlyFlakeDetectionEnabled = false
    let earlyFlakeDetectionNumRetries = 0
    let knownTests = {}

    try {
      const { err, libraryConfig } = await getChannelPromise(libraryConfigurationCh)
      if (!err) {
        isFlakyTestRetriesEnabled = libraryConfig.isFlakyTestRetriesEnabled
        flakyTestRetriesCount = libraryConfig.flakyTestRetriesCount
        isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
        earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries
      }
    } catch (e) {
      isFlakyTestRetriesEnabled = false
      isEarlyFlakeDetectionEnabled = false
    }

    if (isFlakyTestRetriesEnabled && !this.ctx.config.retry && flakyTestRetriesCount > 0) {
      this.ctx.config.retry = flakyTestRetriesCount
    }

    if (isEarlyFlakeDetectionEnabled) {
      const knownTestsResponse = await getChannelPromise(knownTestsCh)
      if (!knownTestsResponse.err) {
        // TODO: check if there's a big difference between the known tests and the current tests
        // to disable the feature
        knownTests = knownTestsResponse.knownTests
      } else {
        isEarlyFlakeDetectionEnabled = false
      }
      // TODO: use this to pass session and module IDs to the worker, instead of polluting process.env
      // Note: setting this.ctx.config.provide directly does not work because it's cached
      try {
        const workspaceProject = this.ctx.getCoreWorkspaceProject()
        workspaceProject._provided._ddKnownTests = knownTests.vitest
        workspaceProject._provided._ddIsEarlyFlakeDetectionEnabled = isEarlyFlakeDetectionEnabled
        workspaceProject._provided._ddEarlyFlakeDetectionNumRetries = earlyFlakeDetectionNumRetries
      } catch (e) {
        log.error('Could not send known tests to workers so Early Flake Detection will not work.')
      }
    }

    let testCodeCoverageLinesTotal

    if (this.ctx.coverageProvider?.generateCoverage) {
      shimmer.wrap(this.ctx.coverageProvider, 'generateCoverage', generateCoverage => async function () {
        const totalCodeCoverage = await generateCoverage.apply(this, arguments)

        try {
          testCodeCoverageLinesTotal = totalCodeCoverage.getCoverageSummary().lines.pct
        } catch (e) {
          // ignore errors
        }
        return totalCodeCoverage
      })
    }

    shimmer.wrap(this.ctx, 'exit', exit => async function () {
      let onFinish

      const flushPromise = new Promise(resolve => {
        onFinish = resolve
      })
      const failedSuites = this.state.getFailedFilepaths()
      let error
      if (failedSuites.length) {
        error = new Error(`Test suites failed: ${failedSuites.length}.`)
      }

      sessionAsyncResource.runInAsyncScope(() => {
        testSessionFinishCh.publish({
          status: getSessionStatus(this.state),
          testCodeCoverageLinesTotal,
          error,
          onFinish
        })
      })

      await flushPromise

      return exit.apply(this, arguments)
    })

    return sort.apply(this, arguments)
  }
}

function getCreateCliWrapper (vitestPackage, frameworkVersion) {
  shimmer.wrap(vitestPackage, 'c', oldCreateCli => function () {
    if (!testSessionStartCh.hasSubscribers) {
      return oldCreateCli.apply(this, arguments)
    }
    sessionAsyncResource.runInAsyncScope(() => {
      const processArgv = process.argv.slice(2).join(' ')
      testSessionStartCh.publish({ command: `vitest ${processArgv}`, frameworkVersion })
    })
    return oldCreateCli.apply(this, arguments)
  })

  return vitestPackage
}

addHook({
  name: 'vitest',
  versions: ['>=1.6.0'],
  file: 'dist/runners.js'
}, (vitestPackage) => {
  const { VitestTestRunner } = vitestPackage

  // `onBeforeRunTask` is run before any repetition or attempt is run
  shimmer.wrap(VitestTestRunner.prototype, 'onBeforeRunTask', onBeforeRunTask => async function (task) {
    const testName = getTestName(task)
    let isNew = false

    try {
      const {
        _ddKnownTests: knownTests,
        _ddIsEarlyFlakeDetectionEnabled: isEarlyFlakeDetectionEnabled,
        _ddEarlyFlakeDetectionNumRetries: numRepeats
      } = globalThis.__vitest_worker__.providedContext

      if (isEarlyFlakeDetectionEnabled) {
        // TODO: does this work for suites whose root is not cwd?
        const testsForThisTestSuite = knownTests[task.file.name] || []
        isNew = !testsForThisTestSuite.includes(testName)

        if (isNew) {
          task.repeats = numRepeats
          newTasks.add(task)
        }
      }
    } catch (e) {
      log.error('Vitest workers could not parse known tests, so Early Flake Detection will not work.')
    }

    return onBeforeRunTask.apply(this, arguments)
  })

  // test start (only tests that are not marked as skip or todo)
  // `onBeforeTryTask` is run for every repeition and attempt of the test
  shimmer.wrap(VitestTestRunner.prototype, 'onBeforeTryTask', onBeforeTryTask => async function (task, retryInfo) {
    if (!testStartCh.hasSubscribers) {
      return onBeforeTryTask.apply(this, arguments)
    }
    const testName = getTestName(task)
    let isNew = false

    try {
      const {
        _ddIsEarlyFlakeDetectionEnabled: isEarlyFlakeDetectionEnabled
      } = globalThis.__vitest_worker__.providedContext

      if (isEarlyFlakeDetectionEnabled) {
        isNew = newTasks.has(task)
      }
    } catch (e) {
      log.error('Vitest workers could not parse known tests, so Early Flake Detection will not work.')
    }
    const { retry: numAttempt, repeats: numRepetition } = retryInfo
    // it can be repeated

    // We finish the previous test here because we know it has failed already
    if (numAttempt > 0) {
      const asyncResource = taskToAsync.get(task)
      const testError = task.result?.errors?.[0]
      if (asyncResource) {
        asyncResource.runInAsyncScope(() => {
          testErrorCh.publish({ error: testError })
        })
      }
    }
    if (numRepetition === 0) {
      taskToStatuses.set(task, [task.result.state])
    }

    // TODO: only do this if EFD is enabled
    if (numRepetition > 0 && numRepetition < 10) { // it may or may have not failed
      const statuses = taskToStatuses.get(task)
      // here we finish the earlier iteration,
      // as long as it's not the _last_ iteration (which will be finished normally)
      // TODO: check duration (not to repeat if it's too slow)
      statuses.push(task.result.state)
      const asyncResource = taskToAsync.get(task)
      if (asyncResource) {
        if (task.result.state === 'fail') {
          const testError = task.result?.errors?.[0]
          asyncResource.runInAsyncScope(() => {
            testErrorCh.publish({ error: testError })
          })
        } else {
          asyncResource.runInAsyncScope(() => {
            testPassCh.publish({ task })
          })
        }
        // we make it pass so it doesn't fail the test
        // TODO: does this work? Add enough tests
        task.result.state = 'pass'
      }
    } else if (numRepetition === 10) {
      // we modify the status to be the EFD status (if one passes, it's a pass)
      const statuses = taskToStatuses.get(task)
      statuses.push(task.result.state)
      const asyncResource = taskToAsync.get(task)
      if (task.result.state === 'fail') {
        const testError = task.result?.errors?.[0]
        asyncResource.runInAsyncScope(() => {
          testErrorCh.publish({ error: testError })
        })
      } else {
        asyncResource.runInAsyncScope(() => {
          testPassCh.publish({ task })
        })
      }
      const hasPass = statuses.includes('pass')
      if (hasPass) {
        task.result.state = 'pass'
      }
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    taskToAsync.set(task, asyncResource)

    asyncResource.runInAsyncScope(() => {
      testStartCh.publish({
        testName,
        testSuiteAbsolutePath: task.file.filepath,
        isRetry: numAttempt > 0 || numRepetition > 0,
        isNew
      })
    })
    return onBeforeTryTask.apply(this, arguments)
  })

  // test finish (only passed tests)
  shimmer.wrap(VitestTestRunner.prototype, 'onAfterTryTask', onAfterTryTask =>
    async function (task, { retry: retryCount, repeats: numRepetition }) {
      if (!testFinishTimeCh.hasSubscribers) {
        return onAfterTryTask.apply(this, arguments)
      }
      const result = await onAfterTryTask.apply(this, arguments)

      const status = getVitestTestStatus(task, retryCount)
      const asyncResource = taskToAsync.get(task)

      if (asyncResource) {
        // We don't finish here because the test might fail in a later hook (afterEach)
        // DOES NOT WORK FOR REPEAT
        // check if repeat
        asyncResource.runInAsyncScope(() => {
          testFinishTimeCh.publish({ status, task })
        })
      }

      return result
    })

  return vitestPackage
})

// There are multiple index* files across different versions of vitest,
// so we check for the existence of BaseSequencer to determine if we are in the right file
addHook({
  name: 'vitest',
  versions: ['>=1.6.0 <2.0.0'],
  filePattern: 'dist/vendor/index.*'
}, (vitestPackage) => {
  if (isReporterPackage(vitestPackage)) {
    shimmer.wrap(vitestPackage.B.prototype, 'sort', getSortWrapper)
  }

  return vitestPackage
})

addHook({
  name: 'vitest',
  versions: ['>=2.0.0 <2.0.5'],
  filePattern: 'dist/vendor/index.*'
}, (vitestPackage) => {
  if (isReporterPackageNew(vitestPackage)) {
    shimmer.wrap(vitestPackage.e.prototype, 'sort', getSortWrapper)
  }

  return vitestPackage
})

addHook({
  name: 'vitest',
  versions: ['>=2.1.0'],
  filePattern: 'dist/chunks/RandomSequencer.*'
}, (randomSequencerPackage) => {
  shimmer.wrap(randomSequencerPackage.B.prototype, 'sort', getSortWrapper)
  return randomSequencerPackage
})

addHook({
  name: 'vitest',
  versions: ['>=2.0.5 <2.1.0'],
  filePattern: 'dist/chunks/index.*'
}, (vitestPackage) => {
  if (isReporterPackageNewest(vitestPackage)) {
    shimmer.wrap(vitestPackage.h.prototype, 'sort', getSortWrapper)
  }

  return vitestPackage
})

// Can't specify file because compiled vitest includes hashes in their files
addHook({
  name: 'vitest',
  versions: ['>=1.6.0 <2.0.5'],
  filePattern: 'dist/vendor/cac.*'
}, getCreateCliWrapper)

addHook({
  name: 'vitest',
  versions: ['>=2.0.5'],
  filePattern: 'dist/chunks/cac.*'
}, getCreateCliWrapper)

// test suite start and finish
// only relevant for workers
addHook({
  name: '@vitest/runner',
  versions: ['>=1.6.0'],
  file: 'dist/index.js'
}, (vitestPackage, frameworkVersion) => {
  shimmer.wrap(vitestPackage, 'startTests', startTests => async function (testPath) {
    let testSuiteError = null
    if (!testSuiteStartCh.hasSubscribers) {
      return startTests.apply(this, arguments)
    }

    const testSuiteAsyncResource = new AsyncResource('bound-anonymous-fn')
    testSuiteAsyncResource.runInAsyncScope(() => {
      testSuiteStartCh.publish({ testSuiteAbsolutePath: testPath[0], frameworkVersion })
    })
    const startTestsResponse = await startTests.apply(this, arguments)

    let onFinish = null
    const onFinishPromise = new Promise(resolve => {
      onFinish = resolve
    })

    const testTasks = getTypeTasks(startTestsResponse[0].tasks)

    // Only one test task per test, even if there are retries
    testTasks.forEach(task => {
      const testAsyncResource = taskToAsync.get(task)
      const { result } = task

      if (result) {
        const { state, duration, errors } = result
        if (state === 'skip') { // programmatic skip
          testSkipCh.publish({ testName: getTestName(task), testSuiteAbsolutePath: task.file.filepath })
        } else if (state === 'pass') {
          if (testAsyncResource) {
            testAsyncResource.runInAsyncScope(() => {
              testPassCh.publish({ task })
            })
          }
        } else if (state === 'fail') {
          // If it's failing, we have no accurate finish time, so we have to use `duration`
          let testError

          if (errors?.length) {
            testError = errors[0]
          }

          if (testAsyncResource) {
            const isRetry = task.result?.retryCount > 0
            // `duration` is the duration of all the retries, so it can't be used if there are retries
            testAsyncResource.runInAsyncScope(() => {
              testErrorCh.publish({ duration: !isRetry ? duration : undefined, error: testError })
            })
          }
          if (errors?.length) {
            testSuiteError = testError // we store the error to bubble it up to the suite
          }
        }
      } else { // test.skip or test.todo
        testSkipCh.publish({ testName: getTestName(task), testSuiteAbsolutePath: task.file.filepath })
      }
    })

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
      testSuiteAsyncResource.runInAsyncScope(() => {
        testSuiteErrorCh.publish({ error: testSuiteError })
      })
    }

    testSuiteAsyncResource.runInAsyncScope(() => {
      testSuiteFinishCh.publish({ status: testSuiteResult.state, onFinish })
    })

    // TODO: fix too frequent flushes
    await onFinishPromise

    return startTestsResponse
  })

  return vitestPackage
})
