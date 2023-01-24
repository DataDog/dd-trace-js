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

let startedSuites = []

const STATUS_TO_TEST_STATUS = {
  passed: 'pass',
  failed: 'fail',
  timedOut: 'fail',
  skipped: 'skip'
}

let remainingTestsByFile = {}

function getTestsBySuiteFromTestsById (testsById) {
  const testsByTestSuite = {}
  for (const { test } of testsById.values()) {
    const { _requireFile } = test
    if (test._type === 'beforeAll' || test._type === 'afterAll') {
      continue
    }
    if (testsByTestSuite[_requireFile]) {
      testsByTestSuite[_requireFile].push(test)
    } else {
      testsByTestSuite[_requireFile] = [test]
    }
  }
  return testsByTestSuite
}

function getRootDir (playwrightLoader) {
  if (playwrightLoader._fullConfig) {
    return playwrightLoader._fullConfig.rootDir
  }
  if (playwrightLoader._configDir) {
    return playwrightLoader._configDir
  }
  return process.cwd()
}

function dispatcherHook (dispatcherExport) {
  shimmer.wrap(dispatcherExport.Dispatcher.prototype, '_createWorker', createWorker => function () {
    const dispatcher = this
    remainingTestsByFile = getTestsBySuiteFromTestsById(dispatcher._testById)
    const worker = createWorker.apply(this, arguments)

    worker.process.on('message', ({ method, params }) => {
      if (method === 'testBegin') {
        const { test } = dispatcher._testById.get(params.testId)
        const { title: testName, location: { file: testSuiteAbsolutePath }, _type } = test

        if (_type === 'beforeAll' || _type === 'afterAll') {
          return
        }

        const isNewTestSuite = !startedSuites.includes(testSuiteAbsolutePath)

        if (isNewTestSuite) {
          startedSuites.push(testSuiteAbsolutePath)
          const testSuiteAsyncResource = new AsyncResource('bound-anonymous-fn')
          testSuiteToAr.set(testSuiteAbsolutePath, testSuiteAsyncResource)
          testSuiteAsyncResource.runInAsyncScope(() => {
            testSuiteStartCh.publish(testSuiteAbsolutePath)
          })
        }

        const testAsyncResource = new AsyncResource('bound-anonymous-fn')
        testToAr.set(test, testAsyncResource)
        testAsyncResource.runInAsyncScope(() => {
          testStartCh.publish({ testName, testSuiteAbsolutePath })
        })
      } else if (method === 'testEnd') {
        const { test } = dispatcher._testById.get(params.testId)
        const { location: { file: testSuiteAbsolutePath }, results, _type } = test

        if (_type === 'beforeAll' || _type === 'afterAll') {
          return
        }

        const testResult = results[results.length - 1]

        const testStatus = STATUS_TO_TEST_STATUS[testResult.status]

        const testAsyncResource = testToAr.get(test)
        testAsyncResource.runInAsyncScope(() => {
          testFinishCh.publish({ testStatus, steps: testResult.steps, error: testResult.error })
        })

        if (!testSuiteToTestStatuses.has(testSuiteAbsolutePath)) {
          testSuiteToTestStatuses.set(testSuiteAbsolutePath, [testStatus])
        } else {
          testSuiteToTestStatuses.get(testSuiteAbsolutePath).push(testStatus)
        }

        remainingTestsByFile[testSuiteAbsolutePath] = remainingTestsByFile[testSuiteAbsolutePath]
          .filter(currentTest => currentTest !== test)

        if (!remainingTestsByFile[testSuiteAbsolutePath].length) {
          const testStatuses = testSuiteToTestStatuses.get(testSuiteAbsolutePath)

          let testSuiteStatus = 'pass'
          if (testStatuses.some(status => status === 'fail')) {
            testSuiteStatus = 'fail'
          } else if (testStatuses.every(status => status === 'skip')) {
            testSuiteStatus = 'skip'
          }

          const testSuiteAsyncResource = testSuiteToAr.get(testSuiteAbsolutePath)
          testSuiteAsyncResource.runInAsyncScope(() => {
            testSuiteFinishCh.publish(testSuiteStatus)
          })
        }
      }
    })

    return worker
  })
  return dispatcherExport
}

function runnerHook (runnerExport) {
  shimmer.wrap(runnerExport.Runner.prototype, 'runAllTests', runAllTests => async function () {
    const testSessionAsyncResource = new AsyncResource('bound-anonymous-fn')
    const { version: frameworkVersion } = this._loader.fullConfig()

    const rootDir = getRootDir(this._loader)

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

    startedSuites = []
    remainingTestsByFile = {}

    return res
  })

  return runnerExport
}

addHook({
  name: '@playwright/test',
  file: 'lib/runner.js',
  versions: ['>=1.18.0']
}, runnerHook)

addHook({
  name: '@playwright/test',
  file: 'lib/dispatcher.js',
  versions: ['>=1.18.0']
}, dispatcherHook)
