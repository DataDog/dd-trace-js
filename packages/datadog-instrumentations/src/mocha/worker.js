'use strict'

const { addHook, channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const {
  runnableWrapper,
  getOnTestHandler,
  getOnTestEndHandler,
  getOnHookEndHandler,
  getOnFailHandler,
  getOnPendingHandler,
  getRunTestsWrapper
} = require('./utils')
require('./common')

const workerFinishCh = channel('ci:mocha:worker:finish')

const config = {}

addHook({
  name: 'mocha',
  versions: ['>=8.0.0'],
  file: 'lib/mocha.js'
}, (Mocha) => {
  shimmer.wrap(Mocha.prototype, 'run', run => function () {
    if (this.options._ddKnownTests) {
      // If there are known tests, it means isKnownTestsEnabled should be true
      config.isKnownTestsEnabled = true
      config.isEarlyFlakeDetectionEnabled = this.options._ddIsEfdEnabled
      config.knownTests = this.options._ddKnownTests
      config.earlyFlakeDetectionNumRetries = this.options._ddEfdNumRetries
      delete this.options._ddIsEfdEnabled
      delete this.options._ddKnownTests
      delete this.options._ddEfdNumRetries
    }
    return run.apply(this, arguments)
  })

  return Mocha
})

// Runner is also hooked in mocha/main.js, but in here we only generate test events.
addHook({
  name: 'mocha',
  versions: ['>=5.2.0'],
  file: 'lib/runner.js'
}, function (Runner) {
  shimmer.wrap(Runner.prototype, 'runTests', runTests => getRunTestsWrapper(runTests, config))

  shimmer.wrap(Runner.prototype, 'run', run => function () {
    if (!workerFinishCh.hasSubscribers) {
      return run.apply(this, arguments)
    }
    // We flush when the worker ends with its test file (a mocha instance in a worker runs a single test file)
    this.on('end', () => {
      workerFinishCh.publish()
    })
    this.on('test', getOnTestHandler(false))

    this.on('test end', getOnTestEndHandler())

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
  file: 'lib/runnable.js'
}, runnableWrapper)
// TODO: parallel mode does not support flaky test retries, so no library config is passed.
