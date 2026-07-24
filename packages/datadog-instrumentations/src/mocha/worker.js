'use strict'

const { addHook, channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const { getEnvironmentVariable } = require('../../../dd-trace/src/config/helper')
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
} = require('./utils')
const {
  CONFIGURATION_REQUEST,
  CONFIGURATION_RESPONSE,
  SUITE_FINISH,
  WEBDRIVERIO_WORKER_ENV,
  WORKER_READY,
} = require('./webdriverio-protocol')
require('./common')

const MINIMUM_MOCHA_VERSION = DD_MAJOR >= 6 ? '>=8.0.0' : '>=5.2.0'

const workerFinishCh = channel('ci:mocha:worker:finish')

const config = {}
const runnerToFiles = new WeakMap()
const isWebdriverioWorker = !!getEnvironmentVariable(WEBDRIVERIO_WORKER_ENV)
let configurationRequestId = 0

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
    config.earlyFlakeDetectionNumRetries = options._ddEfdNumRetries
    config.earlyFlakeDetectionSlowTestRetries = options._ddEfdSlowTestRetries ?? {}
    delete options._ddIsEfdEnabled
    delete options._ddKnownTests
    delete options._ddEfdNumRetries
    delete options._ddEfdSlowTestRetries
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
  if (!process.send) {
    onDone({})
    return
  }

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
  process.send({
    origin: 'datadog',
    name: CONFIGURATION_REQUEST,
    content: {
      files,
      frameworkVersion,
      requestId,
    },
  }, error => {
    if (error) {
      finish({})
    }
  })
}

/**
 * Reports the Mocha version as soon as WebdriverIO loads its framework adapter.
 *
 * @param {string} frameworkVersion
 * @returns {void}
 */
function reportWebdriverioWorkerReady (frameworkVersion) {
  if (!isWebdriverioWorker || !process.send) {
    return
  }

  process.send({
    origin: 'datadog',
    name: WORKER_READY,
    content: { frameworkVersion },
  })
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
    if (test.state === 'failed' || test.timedOut || test._ddHookFailed) {
      result.status = 'fail'
    } else if (!test.isPending()) {
      result.hasPassingTest = true
    }
  })

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
 * @returns {void}
 */
function reportWebdriverioSuiteResults (runner) {
  if (!isWebdriverioWorker || !process.send) {
    return
  }

  process.send({
    origin: 'datadog',
    name: SUITE_FINISH,
    content: {
      results: getWebdriverioSuiteResults(runner),
    },
  })
}

function isFailedTestReplayEnabled () {
  return config.isTestDynamicInstrumentationEnabled && config.isDiEnabled
}

addHook({
  name: 'mocha',
  versions: ['>=8.0.0'],
  file: 'lib/mocha.js',
}, (Mocha, frameworkVersion) => {
  reportWebdriverioWorkerReady(frameworkVersion)

  shimmer.wrap(Mocha.prototype, 'run', run => function (...args) {
    applyMochaOptions(this.options)
    if (!isWebdriverioWorker || !workerFinishCh.hasSubscribers) {
      return run.apply(this, args)
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
      }
      filterSkippedFiles(runner, skippedFiles)
      if (isFailedTestReplayEnabled()) {
        patchFailedTestReplayHookUp(runner.constructor)
      }
      runner.suite.run()
    })

    return runner
  })

  return Mocha
})

// Runner is also hooked in mocha/main.js, but in here we only generate test events.
addHook({
  name: 'mocha',
  versions: [MINIMUM_MOCHA_VERSION],
  file: 'lib/runner.js',
}, function (Runner) {
  shimmer.wrap(Runner.prototype, 'runTests', runTests => getRunTestsWrapper(runTests, config))

  shimmer.wrap(Runner.prototype, 'run', run => function (...args) {
    if (!workerFinishCh.hasSubscribers) {
      return run.apply(this, args)
    }
    if (isFailedTestReplayEnabled()) {
      patchFailedTestReplayHookUp(Runner)
    }
    // We flush when the worker ends with its test file (a mocha instance in a worker runs a single test file)
    this.once('end', () => {
      workerFinishCh.publish()
      reportWebdriverioSuiteResults(this)
    })
    this.on('test', getOnTestHandler(false))

    this.on('test end', getOnTestEndHandler(config))

    this.on('retry', getOnTestRetryHandler(config))

    // If the hook passes, 'hook end' will be emitted. Otherwise, 'fail' will be emitted
    this.on('hook end', getOnHookEndHandler(config))

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
