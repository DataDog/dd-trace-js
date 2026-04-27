'use strict'

const { addHook, channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const {
  getV8CoverageCollector,
  startV8Coverage,
  stopV8Coverage,
} = require('../../../dd-trace/src/ci-visibility/code-coverage/v8-coverage')

const {
  runnableWrapper,
  getOnTestHandler,
  getOnTestEndHandler,
  getOnHookEndHandler,
  getOnFailHandler,
  getOnPendingHandler,
  getOnTestRetryHandler,
  getRunTestsWrapper,
} = require('./utils')
require('./common')

const workerFinishCh = channel('ci:mocha:worker:finish')

const config = {}

addHook({
  name: 'mocha',
  versions: ['>=8.0.0'],
  file: 'lib/mocha.js',
}, (Mocha) => {
  shimmer.wrap(Mocha.prototype, 'loadFilesAsync', loadFilesAsync => function () {
    if (this.options._ddIsCodeCoverageEnabled) {
      startV8Coverage({ cwd: this.options._ddCoverageRoot || process.cwd() })
    }
    return loadFilesAsync.apply(this, arguments)
  })

  shimmer.wrap(Mocha.prototype, 'run', run => function () {
    const isCodeCoverageEnabled = this.options._ddIsCodeCoverageEnabled
    if (this.options._ddIsKnownTestsEnabled) {
      config.isKnownTestsEnabled = true
      config.isEarlyFlakeDetectionEnabled = this.options._ddIsEfdEnabled
      config.knownTests = this.options._ddKnownTests
      config.earlyFlakeDetectionNumRetries = this.options._ddEfdNumRetries
      delete this.options._ddIsEfdEnabled
      delete this.options._ddKnownTests
      delete this.options._ddEfdNumRetries
      delete this.options._ddIsKnownTestsEnabled
    }
    if (this.options._ddIsImpactedTestsEnabled) {
      config.isImpactedTestsEnabled = true
      config.modifiedFiles = this.options._ddModifiedFiles
      delete this.options._ddIsImpactedTestsEnabled
      delete this.options._ddModifiedFiles
    }
    if (this.options._ddIsTestManagementTestsEnabled) {
      config.isTestManagementTestsEnabled = true
      config.testManagementAttemptToFixRetries = this.options._ddTestManagementAttemptToFixRetries
      config.testManagementTests = this.options._ddTestManagementTests
      delete this.options._ddIsTestManagementTestsEnabled
      delete this.options._ddTestManagementAttemptToFixRetries
      delete this.options._ddTestManagementTests
    }
    if (this.options._ddIsFlakyTestRetriesEnabled) {
      config.isFlakyTestRetriesEnabled = true
      config.flakyTestRetriesCount = this.options._ddFlakyTestRetriesCount
      delete this.options._ddIsFlakyTestRetriesEnabled
      delete this.options._ddFlakyTestRetriesCount
    }
    if (isCodeCoverageEnabled) {
      delete this.options._ddIsCodeCoverageEnabled
      delete this.options._ddCoverageRoot
    }

    const args = Array.prototype.slice.call(arguments)
    const done = args[0]
    if (isCodeCoverageEnabled && typeof done === 'function') {
      args[0] = function (result) {
        const v8Collector = getV8CoverageCollector()
        if (v8Collector && result && typeof result === 'object') {
          result._ddCoverageFiles = v8Collector.getFilesCoveredSinceLastSnapshot()
        }
        stopV8Coverage()
        return done.apply(this, arguments)
      }
    }

    return run.apply(this, args)
  })

  return Mocha
})

// Runner is also hooked in mocha/main.js, but in here we only generate test events.
addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runner.js',
}, function (Runner) {
  shimmer.wrap(Runner.prototype, 'runTests', runTests => getRunTestsWrapper(runTests, config))

  shimmer.wrap(Runner.prototype, 'run', run => function () {
    if (!workerFinishCh.hasSubscribers) {
      return run.apply(this, arguments)
    }
    // We flush when the worker ends with its test file (a mocha instance in a worker runs a single test file)
    this.once('end', () => {
      workerFinishCh.publish()
    })
    this.on('test', getOnTestHandler(false))

    this.on('test end', getOnTestEndHandler(config))

    this.on('retry', getOnTestRetryHandler(config))

    // If the hook passes, 'hook end' will be emitted. Otherwise, 'fail' will be emitted
    this.on('hook end', getOnHookEndHandler())

    this.on('fail', getOnFailHandler(false))

    this.on('pending', getOnPendingHandler())

    return run.apply(this, arguments)
  })
  return Runner
})

// Used both in serial and parallel mode, and by both the main process and the workers
// Used to set the correct async resource to the test.
addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runnable.js',
}, (runnablePackage) => runnableWrapper(runnablePackage, config))
