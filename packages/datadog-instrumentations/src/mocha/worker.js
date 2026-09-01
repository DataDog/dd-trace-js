'use strict'

const { addHook, channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const { EMPTY_EFD_RETRY_POLICY } = require('../../../dd-trace/src/ci-visibility/efd-retry-policy')
const { getEnvironmentVariable } = require('../../../dd-trace/src/config/helper')
const log = require('../../../dd-trace/src/log')
const { DD_MAJOR } = require('../../../../version')

const {
  runnableWrapper,
  getOnTestHandler,
  getOnTestEndHandler,
  getOnHookEndHandler,
  getOnFailHandler,
  getOnPendingHandler,
  getOnTestRetryHandler,
  getRunTestsWrapper,
  patchFailedTestReplayHookUp,
  adjustRunnerFailuresForTestOptimization,
  efdTests,
  getTestFullName,
} = require('./utils')
const {
  CONFIGURATION_REQUEST,
  CONFIGURATION_RESPONSE,
  sendWebdriverioWorkerMessage,
  SUITE_FINISH,
  WEBDRIVERIO_WORKER_ENV,
  WORKER_READY,
} = require('./webdriverio-protocol')
require('./common')

const MINIMUM_MOCHA_VERSION = DD_MAJOR >= 6 ? '>=8.0.0' : '>=5.2.0'

const workerFinishCh = channel('ci:mocha:worker:finish')
const workerConfigurationCh = channel('ci:mocha:worker:configuration')

const config = {
  earlyFlakeDetectionRetryPolicy: EMPTY_EFD_RETRY_POLICY,
}
const runnerToFiles = new WeakMap()
const runnerToFailedHooks = new WeakMap()
const isWebdriverioWorker = !!getEnvironmentVariable(WEBDRIVERIO_WORKER_ENV)
let configurationRequestId = 0

/**
 * Sends a message to the WebdriverIO launcher without surfacing closed IPC channels.
 *
 * @param {object} message
 * @param {() => void} [onError]
 * @param {() => void} [onDone]
 * @returns {void}
 */
function sendWebdriverioMessage (message, onError, onDone) {
  sendWebdriverioWorkerMessage(message, error => {
    if (error) {
      log.error('WebdriverIO Test Optimization IPC error', error)
    }
    onError?.()
  }, onDone)
}

/**
 * Applies configuration encoded as private Mocha options by its parallel runner.
 *
 * @param {object} options
 * @returns {void}
 */
function applyMochaOptions (options) {
  if (options._ddIsKnownTestsEnabled) {
    config.isKnownTestsEnabled = true
    config.isEarlyFlakeDetectionEnabled = options._ddIsEfdEnabled
    config.knownTests = options._ddKnownTests
    config.earlyFlakeDetectionRetryPolicy = options._ddEfdRetryPolicy ?? EMPTY_EFD_RETRY_POLICY
    delete options._ddIsEfdEnabled
    delete options._ddKnownTests
    delete options._ddEfdRetryPolicy
    delete options._ddIsKnownTestsEnabled
  }
  if (options._ddIsImpactedTestsEnabled) {
    config.isImpactedTestsEnabled = true
    config.modifiedFiles = options._ddModifiedFiles
    delete options._ddIsImpactedTestsEnabled
    delete options._ddModifiedFiles
  }
  if (options._ddIsTestManagementTestsEnabled) {
    config.isTestManagementTestsEnabled = true
    config.testManagementAttemptToFixRetries = options._ddTestManagementAttemptToFixRetries
    config.testManagementTests = options._ddTestManagementTests
    delete options._ddIsTestManagementTestsEnabled
    delete options._ddTestManagementAttemptToFixRetries
    delete options._ddTestManagementTests
  }
  if (options._ddIsFlakyTestRetriesEnabled) {
    config.isFlakyTestRetriesEnabled = true
    config.flakyTestRetriesCount = options._ddFlakyTestRetriesCount
    delete options._ddIsFlakyTestRetriesEnabled
    delete options._ddFlakyTestRetriesCount
  }
  if (options._ddIsFailedTestReplayEnabled) {
    config.isTestDynamicInstrumentationEnabled = true
    config.isDiEnabled = true
    delete options._ddIsFailedTestReplayEnabled
  }
}

/**
 * Removes files selected for suite-level skipping from an already loaded Mocha root suite.
 *
 * @param {object} runner
 * @param {string[]} skippedFiles
 * @returns {void}
 */
function filterSkippedFiles (runner, skippedFiles) {
  if (!skippedFiles.length) {
    return
  }

  const skippedFilesSet = new Set(skippedFiles)
  runner.suite.suites = runner.suite.suites.filter(suite => !skippedFilesSet.has(suite.file))
  runner.suite.tests = runner.suite.tests.filter(test => !skippedFilesSet.has(test.file))
}

/**
 * Requests configuration from the WebdriverIO launcher before releasing Mocha's delayed root suite.
 *
 * @param {string} frameworkVersion
 * @param {string[]} files
 * @param {(response: object) => void} onDone
 * @returns {void}
 */
function requestWebdriverioConfiguration (frameworkVersion, files, onDone) {
  const requestId = `${process.pid}-${++configurationRequestId}`
  let finished = false

  /**
   * Finishes the configuration request exactly once.
   *
   * @param {object} response
   * @returns {void}
   */
  function finish (response) {
    if (finished) {
      return
    }
    finished = true
    clearTimeout(timeout)
    process.off('message', onMessage)
    process.off('disconnect', onDisconnect)
    onDone(response)
  }

  /**
   * Receives the matching coordinator response.
   *
   * @param {object} message
   * @returns {void}
   */
  function onMessage (message) {
    if (message?.name === CONFIGURATION_RESPONSE && message.content?.requestId === requestId) {
      finish(message.content)
    }
  }

  /**
   * Releases the runner if its parent disconnects.
   *
   * @returns {void}
   */
  function onDisconnect () {
    finish({})
  }

  const timeout = setTimeout(() => finish({}), 30_000)
  process.on('message', onMessage)
  process.once('disconnect', onDisconnect)
  sendWebdriverioMessage({
    origin: 'datadog',
    name: CONFIGURATION_REQUEST,
    content: {
      files,
      frameworkVersion,
      requestId,
    },
  }, () => finish({}))
}

/**
 * Reports the Mocha version as soon as WebdriverIO loads its framework adapter.
 *
 * @param {string} frameworkVersion
 * @returns {void}
 */
function reportWebdriverioWorkerReady (frameworkVersion) {
  if (!isWebdriverioWorker) {
    return
  }

  sendWebdriverioMessage({
    origin: 'datadog',
    name: WORKER_READY,
    content: { frameworkVersion },
  })
}

/**
 * Checks whether Test Optimization converts a failed WebdriverIO test attempt to a passing result.
 *
 * @param {object|undefined} test
 * @returns {boolean}
 */
function isWebdriverioFailureSuppressed (test) {
  if (!test) {
    return false
  }
  const hasPassingEfdAttempt = config.isEarlyFlakeDetectionEnabled &&
    efdTests[getTestFullName(test)]?.some(attempt => attempt.state === 'passed' && !attempt._ddHookFailed)
  return (test._ddIsQuarantined && !test._ddIsAttemptToFix) || hasPassingEfdAttempt
}

/**
 * Gets the test owned by a per-test hook without associating suite hooks with boundary tests.
 *
 * @param {object} hook
 * @returns {object|undefined}
 */
function getWebdriverioHookTest (hook) {
  const { parent } = hook
  const isTestHook = parent?._beforeEach?.includes(hook) || parent?._afterEach?.includes(hook)
  return isTestHook ? hook.ctx?.currentTest : undefined
}

/**
 * Removes managed hook failures from WebdriverIO's Mocha runner totals.
 *
 * @param {object} runner
 * @returns {void}
 */
function adjustWebdriverioHookFailures (runner) {
  let suppressedFailures = 0
  for (const { test } of runnerToFailedHooks.get(runner)) {
    if (isWebdriverioFailureSuppressed(test)) {
      suppressedFailures++
    }
  }
  if (runner.stats) {
    runner.stats.failures -= suppressedFailures
  }
  runner.failures -= suppressedFailures
}

/**
 * Computes a final result for every file loaded into one Mocha worker.
 *
 * @param {object} runner
 * @returns {object[]}
 */
function getWebdriverioSuiteResults (runner) {
  const resultsByFile = new Map()
  const files = runnerToFiles.get(runner) || []

  for (const file of files) {
    resultsByFile.set(file, {
      file,
      hasPassingTest: false,
      status: 'skip',
    })
  }

  runner.suite.eachTest(test => {
    const result = resultsByFile.get(test.file)
    if (!result) {
      return
    }
    const isSuppressedFailure = isWebdriverioFailureSuppressed(test)
    if ((test.state === 'failed' || test.timedOut || test._ddHookFailed) && !isSuppressedFailure) {
      result.status = 'fail'
    } else if (test.state === 'passed' || isSuppressedFailure) {
      result.hasPassingTest = true
    }
  })

  for (const { file, test } of runnerToFailedHooks.get(runner)) {
    const result = resultsByFile.get(file)
    if (result && !isWebdriverioFailureSuppressed(test)) {
      result.status = 'fail'
    }
  }

  const results = []
  let hasFailedSuite = false
  for (const result of resultsByFile.values()) {
    if (result.status === 'fail') {
      hasFailedSuite = true
    } else if (result.hasPassingTest) {
      result.status = 'pass'
    }
    delete result.hasPassingTest
    results.push(result)
  }

  if (runner.failures > 0 && !hasFailedSuite) {
    for (const result of results) {
      result.status = 'fail'
    }
  }

  return results
}

/**
 * Sends suite results to the WebdriverIO launcher.
 *
 * @param {object} runner
 * @param {() => void} [onDone]
 * @returns {void}
 */
function reportWebdriverioSuiteResults (runner, onDone) {
  if (!isWebdriverioWorker) {
    onDone?.()
    return
  }

  sendWebdriverioMessage({
    origin: 'datadog',
    name: SUITE_FINISH,
    content: {
      results: getWebdriverioSuiteResults(runner),
    },
  }, undefined, onDone)
}

/**
 * Flushes worker payloads before reporting suite results and completing Mocha.
 *
 * @param {object} runner
 * @param {() => void} onDone
 * @returns {void}
 */
function finishWebdriverioWorker (runner, onDone) {
  try {
    workerFinishCh.publish({
      onDone: () => {
        try {
          reportWebdriverioSuiteResults(runner, onDone)
        } catch (error) {
          log.error('WebdriverIO Test Optimization worker completion error', error)
          onDone()
        }
      },
    })
  } catch (error) {
    log.error('WebdriverIO Test Optimization worker completion error', error)
    onDone()
  }
}

function isFailedTestReplayEnabled () {
  return config.isTestDynamicInstrumentationEnabled && config.isDiEnabled
}

/**
 * @param {Function} Mocha
 * @param {string} frameworkVersion
 * @returns {Function}
 */
function wrapMochaRun (Mocha, frameworkVersion) {
  reportWebdriverioWorkerReady(frameworkVersion)

  // Shimmer is required because run must return its Runner while execution is paused and resumed after configuration.
  shimmer.wrap(Mocha.prototype, 'run', run => function (...args) {
    applyMochaOptions(this.options)
    if (!isWebdriverioWorker || !workerFinishCh.hasSubscribers) {
      return run.apply(this, args)
    }

    const isUserDelayed = this.options.delay
    const rootSuite = this.suite
    const rootSuiteRun = rootSuite.run
    const hasOwnRootSuiteRun = Object.hasOwn(rootSuite, 'run')
    let configurationReady = false
    let userReady = !isUserDelayed

    /**
     * Restores the root suite method after both delayed-mode gates are open.
     *
     * @returns {void}
     */
    function restoreRootSuiteRun () {
      if (hasOwnRootSuiteRun) {
        rootSuite.run = rootSuiteRun
      } else {
        delete rootSuite.run
      }
    }

    if (isUserDelayed) {
      rootSuite.run = function (...args) {
        userReady = true
        if (!configurationReady) {
          return
        }
        restoreRootSuiteRun()
        return rootSuiteRun.apply(this, args)
      }
    }

    this.options.delay = true
    const files = [...this.files]
    const runner = run.apply(this, args)
    runnerToFiles.set(runner, files)

    requestWebdriverioConfiguration(frameworkVersion, files, ({
      configuration,
      skippedFiles = [],
    }) => {
      if (configuration) {
        Object.assign(config, configuration)
        workerConfigurationCh.publish({
          libraryConfig: config,
          repositoryRoot: config.repositoryRoot,
          testFramework: config.testFramework,
        })
      }
      filterSkippedFiles(runner, skippedFiles)
      if (isFailedTestReplayEnabled()) {
        patchFailedTestReplayHookUp(runner.constructor)
      }
      configurationReady = true
      if (userReady) {
        if (isUserDelayed) {
          restoreRootSuiteRun()
        }
        rootSuite.run()
      }
    })

    return runner
  })

  return Mocha
}

addHook({
  name: 'mocha',
  versions: ['>=8.0.0'],
  filePattern: String.raw`lib/mocha\.(?:c?js)$`,
}, wrapMochaRun)

// Mocha 12's ESM package root loads lib/mocha.cjs before the CJS hook can observe it.
addHook({
  name: 'mocha',
  versions: ['>=12.0.0'],
  file: 'index.js',
  patchDefault: true,
}, wrapMochaRun)

// Runner is also hooked in mocha/main.js, but in here we only generate test events.
addHook({
  name: 'mocha',
  versions: [MINIMUM_MOCHA_VERSION],
  filePattern: String.raw`lib/runner\.(?:c?js)$`,
}, function (Runner) {
  shimmer.wrap(Runner.prototype, 'runTests', runTests => getRunTestsWrapper(runTests, config))

  shimmer.wrap(Runner.prototype, 'run', run => function (...args) {
    if (!workerFinishCh.hasSubscribers) {
      return run.apply(this, args)
    }
    if (isFailedTestReplayEnabled()) {
      patchFailedTestReplayHookUp(Runner)
    }
    if (isWebdriverioWorker) {
      this.prependOnceListener('end', () => {
        try {
          adjustRunnerFailuresForTestOptimization(this, config)
          adjustWebdriverioHookFailures(this)
        } catch (error) {
          log.error('WebdriverIO Test Optimization failure adjustment error', error)
        }
      })
    }
    const onRunDone = args[0]
    if (isWebdriverioWorker && typeof onRunDone === 'function') {
      args[0] = (...onRunDoneArgs) => {
        finishWebdriverioWorker(this, () => onRunDone(...onRunDoneArgs))
      }
    } else {
      // Flush after the worker finishes its Mocha run, including grouped spec files.
      this.once('end', () => {
        try {
          workerFinishCh.publish()
          reportWebdriverioSuiteResults(this)
        } catch (error) {
          log.error('WebdriverIO Test Optimization worker completion error', error)
        }
      })
    }
    this.on('test', getOnTestHandler(false))

    this.on('test end', getOnTestEndHandler(config))

    this.on('retry', getOnTestRetryHandler(config))

    // If the hook passes, 'hook end' will be emitted. Otherwise, 'fail' will be emitted
    this.on('hook end', getOnHookEndHandler(config))

    if (isWebdriverioWorker) {
      const failedHooks = []
      runnerToFailedHooks.set(this, failedHooks)
      this.on('fail', runnable => {
        if (runnable.type === 'hook' && runnable.file) {
          failedHooks.push({
            file: runnable.file,
            test: getWebdriverioHookTest(runnable),
          })
        }
      })
    }
    this.on('fail', getOnFailHandler(false, config))

    this.on('pending', getOnPendingHandler())

    return run.apply(this, args)
  })
  return Runner
})

// Used both in serial and parallel mode, and by both the main process and the workers
// Used to set the correct async resource to the test.
addHook({
  name: 'mocha',
  versions: [MINIMUM_MOCHA_VERSION],
  file: 'lib/runnable.js',
}, (runnablePackage) => runnableWrapper(runnablePackage, config))
