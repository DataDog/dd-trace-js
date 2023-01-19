const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const testStartCh = channel('ci:playwright:test:start')
const testFinishCh = channel('ci:playwright:test:finish')

const testSessionStartCh = channel('ci:playwright:session:start')
const testSessionFinishCh = channel('ci:playwright:session:finish')

const testSuiteStartCh = channel('ci:playwright:test-suite:start')
const testSuiteFinishCh = channel('ci:playwright:test-suite:finish')

const testToAr = new WeakMap()
const testSuiteToAr = new Map()
const testSuiteToTestStatuses = new Map()

const STATUS_TO_TEST_STATUS = {
  passed: 'pass',
  failed: 'fail',
  timedOut: 'fail',
  skipped: 'skip'
}

addHook({
  name: '@playwright/test',
  file: 'lib/workerRunner.js',
  versions: ['>=1.10.0']
}, (workerRunnerPackage) => {
  // This runs in the worker process
  shimmer.wrap(workerRunnerPackage.WorkerRunner.prototype, 'runTestGroup', runTestGroup => async function () {
    const testGroup = arguments[0]
    process.send({ method: 'ddTestSuiteStart', params: { testSuite: testGroup.file } })
    const res = await runTestGroup.apply(this, arguments)
    process.send({ method: 'ddTestSuiteEnd', params: { testSuite: testGroup.file } })
    return res
  })
  return workerRunnerPackage
})

addHook({
  name: '@playwright/test',
  file: 'lib/runner.js',
  versions: ['>=1.10.0']
}, (RunnerExport) => {
  shimmer.wrap(RunnerExport.Runner.prototype, 'runAllTests', runAllTests => async function () {
    const testSessionAsyncResource = new AsyncResource('bound-anonymous-fn')
    const { _configDir: rootDir, version: frameworkVersion } = this._loader.fullConfig()

    const processArgv = process.argv.slice(2).join(' ')
    const command = `playwright ${processArgv}`
    testSessionAsyncResource.runInAsyncScope(() => {
      testSessionStartCh.publish({ command, frameworkVersion, rootDir })
    })

    const res = await runAllTests.apply(this, arguments)
    const sessionStatus = STATUS_TO_TEST_STATUS[res.status]

    let onDone

    const flushWait = new Promise(resolve => {
      onDone = resolve
    })

    testSessionAsyncResource.runInAsyncScope(() => {
      testSessionFinishCh.publish({ status: sessionStatus, onDone })
    })
    await flushWait

    return res
  })
  return RunnerExport
})

addHook({
  name: '@playwright/test',
  file: 'lib/dispatcher.js',
  versions: ['>=1.10.0']
}, (dispatcher) => {
  shimmer.wrap(dispatcher.Dispatcher.prototype, '_createWorker', createWorker => function () {
    const dispatcher = this
    const worker = createWorker.apply(this, arguments)

    worker.process.on('message', ({ method, params }) => {
      if (method === 'testBegin') {
        const { test } = dispatcher._testById.get(params.testId)
        const testAsyncResource = new AsyncResource('bound-anonymous-fn')
        testToAr.set(test, testAsyncResource)
        testAsyncResource.runInAsyncScope(() => {
          testStartCh.publish(test)
        })
      } else if (method === 'testEnd') {
        const { test } = dispatcher._testById.get(params.testId)
        const result = test.results[test.results.length - 1]

        const testStatus = STATUS_TO_TEST_STATUS[result.status]

        const testAsyncResource = testToAr.get(test)
        testAsyncResource.runInAsyncScope(() => {
          testFinishCh.publish({ testStatus, steps: result.steps, error: result.error })
        })
        if (!testSuiteToTestStatuses.has(test.location.file)) {
          testSuiteToTestStatuses.set(test.location.file, [testStatus])
        } else {
          testSuiteToTestStatuses.get(test.location.file).push(testStatus)
        }
      } else if (method === 'ddTestSuiteStart') {
        const testSuiteAsyncResource = new AsyncResource('bound-anonymous-fn')
        testSuiteToAr.set(params.testSuite, testSuiteAsyncResource)
        testSuiteAsyncResource.runInAsyncScope(() => {
          testSuiteStartCh.publish(params.testSuite)
        })
      } else if (method === 'ddTestSuiteEnd') {
        const testStatuses = testSuiteToTestStatuses.get(params.testSuite)

        // TODO: bubble up test error to suite (testSuiteToTestStatuses will have to carry errors)
        let testSuiteStatus = 'pass'
        if (testStatuses.some(status => status === 'fail')) {
          testSuiteStatus = 'fail'
        } else if (testStatuses.every(status => status === 'skip')) {
          testSuiteStatus = 'skip'
        }

        const testSuiteAsyncResource = testSuiteToAr.get(params.testSuite)
        testSuiteAsyncResource.runInAsyncScope(() => {
          testSuiteFinishCh.publish(testSuiteStatus)
        })
      }
    })

    return worker
  })
  return dispatcher
})
