const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { parseAnnotations } = require('../../dd-trace/src/plugins/util/test')

const testStartCh = channel('ci:playwright:test:start')
const testFinishCh = channel('ci:playwright:test:finish')

const testSessionStartCh = channel('ci:playwright:session:start')
const testSessionFinishCh = channel('ci:playwright:session:finish')

const testSuiteStartCh = channel('ci:playwright:test-suite:start')
const testSuiteFinishCh = channel('ci:playwright:test-suite:finish')

const testToAr = new WeakMap()
const testSuiteToAr = new Map()
const testSuiteToTestStatuses = new Map()
const testSuiteToErrors = new Map()

let startedSuites = []

const STATUS_TO_TEST_STATUS = {
  passed: 'pass',
  failed: 'fail',
  timedOut: 'fail',
  skipped: 'skip'
}

let remainingTestsByFile = {}

function getTestsBySuiteFromTestGroups (testGroups) {
  return testGroups.reduce((acc, { requireFile, tests }) => {
    if (acc[requireFile]) {
      acc[requireFile] = acc[requireFile].concat(tests)
    } else {
      acc[requireFile] = tests
    }
    return acc
  }, {})
}

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

function getPlaywrightConfig (playwrightRunner) {
  try {
    return playwrightRunner._configLoader.fullConfig()
  } catch (e) {
    try {
      return playwrightRunner._loader.fullConfig()
    } catch (e) {
      return playwrightRunner._config || {}
    }
  }
}

function getRootDir (playwrightRunner) {
  const config = getPlaywrightConfig(playwrightRunner)
  if (config.rootDir) {
    return config.rootDir
  }
  if (playwrightRunner._configDir) {
    return playwrightRunner._configDir
  }
  if (playwrightRunner._config) {
    return playwrightRunner._config.config?.rootDir || process.cwd()
  }
  return process.cwd()
}

function getProjectsFromRunner (runner) {
  const config = getPlaywrightConfig(runner)
  return config.projects?.map((project) => {
    if (project.project) {
      return project.project
    }
    return project
  })
}

function getProjectsFromDispatcher (dispatcher) {
  const newConfig = dispatcher._config?.config?.projects
  if (newConfig) {
    return newConfig
  }
  // old
  return dispatcher._loader?.fullConfig()?.projects
}

function getBrowserNameFromProjects (projects, test) {
  if (!projects || !test) {
    return null
  }
  const { _projectIndex, _projectId: testProjectId } = test

  if (_projectIndex !== undefined) {
    return projects[_projectIndex]?.name
  }

  return projects.find(({ __projectId, _id, name }) => {
    if (__projectId !== undefined) {
      return __projectId === testProjectId
    }
    if (_id !== undefined) {
      return _id === testProjectId
    }
    return name === testProjectId
  })?.name
}

function formatTestHookError (error, hookType, isTimeout) {
  let hookError = error
  if (error) {
    hookError.message = `Error in ${hookType} hook: ${error.message}`
  }
  if (!hookError && isTimeout) {
    hookError = new Error(`${hookType} hook timed out`)
  }
  return hookError
}

function addErrorToTestSuite (testSuiteAbsolutePath, error) {
  if (testSuiteToErrors.has(testSuiteAbsolutePath)) {
    testSuiteToErrors.get(testSuiteAbsolutePath).push(error)
  } else {
    testSuiteToErrors.set(testSuiteAbsolutePath, [error])
  }
}

function getTestSuiteError (testSuiteAbsolutePath) {
  const errors = testSuiteToErrors.get(testSuiteAbsolutePath)
  if (!errors) {
    return null
  }
  if (errors.length === 1) {
    return errors[0]
  }
  return new Error(`${errors.length} errors in this test suite:\n${errors.map(e => e.message).join('\n------\n')}`)
}

function testBeginHandler (test, browserName) {
  const {
    _requireFile: testSuiteAbsolutePath,
    title: testName, _type,
    location: { line: testSourceLine }
  } = test

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
    testStartCh.publish({ testName, testSuiteAbsolutePath, testSourceLine, browserName })
  })
}

function testEndHandler (test, annotations, testStatus, error, isTimeout) {
  let annotationTags
  if (annotations.length) {
    annotationTags = parseAnnotations(annotations)
  }
  const { _requireFile: testSuiteAbsolutePath, results, _type } = test

  if (_type === 'beforeAll' || _type === 'afterAll') {
    const hookError = formatTestHookError(error, _type, isTimeout)

    if (hookError) {
      addErrorToTestSuite(testSuiteAbsolutePath, hookError)
    }
    return
  }

  const testResult = results[results.length - 1]
  const testAsyncResource = testToAr.get(test)
  testAsyncResource.runInAsyncScope(() => {
    testFinishCh.publish({ testStatus, steps: testResult.steps, error, extraTags: annotationTags })
  })

  if (testSuiteToTestStatuses.has(testSuiteAbsolutePath)) {
    testSuiteToTestStatuses.get(testSuiteAbsolutePath).push(testStatus)
  } else {
    testSuiteToTestStatuses.set(testSuiteAbsolutePath, [testStatus])
  }

  if (error) {
    addErrorToTestSuite(testSuiteAbsolutePath, error)
  }

  remainingTestsByFile[testSuiteAbsolutePath] = remainingTestsByFile[testSuiteAbsolutePath]
    .filter(currentTest => currentTest !== test)

  // Last test, we finish the suite
  if (!remainingTestsByFile[testSuiteAbsolutePath].length) {
    const testStatuses = testSuiteToTestStatuses.get(testSuiteAbsolutePath)

    let testSuiteStatus = 'pass'
    if (testStatuses.some(status => status === 'fail')) {
      testSuiteStatus = 'fail'
    } else if (testStatuses.every(status => status === 'skip')) {
      testSuiteStatus = 'skip'
    }

    const suiteError = getTestSuiteError(testSuiteAbsolutePath)
    const testSuiteAsyncResource = testSuiteToAr.get(testSuiteAbsolutePath)
    testSuiteAsyncResource.runInAsyncScope(() => {
      testSuiteFinishCh.publish({ status: testSuiteStatus, error: suiteError })
    })
  }
}

function dispatcherRunWrapper (run) {
  return function () {
    remainingTestsByFile = getTestsBySuiteFromTestsById(this._testById)
    return run.apply(this, arguments)
  }
}

function dispatcherRunWrapperNew (run) {
  return function () {
    remainingTestsByFile = getTestsBySuiteFromTestGroups(arguments[0])
    return run.apply(this, arguments)
  }
}

function dispatcherHook (dispatcherExport) {
  shimmer.wrap(dispatcherExport.Dispatcher.prototype, 'run', dispatcherRunWrapper)
  shimmer.wrap(dispatcherExport.Dispatcher.prototype, '_createWorker', createWorker => function () {
    const dispatcher = this
    const worker = createWorker.apply(this, arguments)
    worker.process.on('message', ({ method, params }) => {
      if (method === 'testBegin') {
        const { test } = dispatcher._testById.get(params.testId)
        const projects = getProjectsFromDispatcher(dispatcher)
        const browser = getBrowserNameFromProjects(projects, test)
        testBeginHandler(test, browser)
      } else if (method === 'testEnd') {
        const { test } = dispatcher._testById.get(params.testId)

        const { results } = test
        const testResult = results[results.length - 1]

        const isTimeout = testResult.status === 'timedOut'
        testEndHandler(test, params.annotations, STATUS_TO_TEST_STATUS[testResult.status], testResult.error, isTimeout)
      }
    })

    return worker
  })
  return dispatcherExport
}

function getTestByTestId (dispatcher, testId) {
  if (dispatcher._testById) {
    return dispatcher._testById.get(testId)?.test
  }
  if (dispatcher._allTests) {
    return dispatcher._allTests.find(({ id }) => id === testId)
  }
}

function dispatcherHookNew (dispatcherExport, runWrapper) {
  shimmer.wrap(dispatcherExport.Dispatcher.prototype, 'run', runWrapper)
  shimmer.wrap(dispatcherExport.Dispatcher.prototype, '_createWorker', createWorker => function () {
    const dispatcher = this
    const worker = createWorker.apply(this, arguments)

    worker.on('testBegin', ({ testId }) => {
      const test = getTestByTestId(dispatcher, testId)
      const projects = getProjectsFromDispatcher(dispatcher)
      const browser = getBrowserNameFromProjects(projects, test)
      testBeginHandler(test, browser)
    })
    worker.on('testEnd', ({ testId, status, errors, annotations }) => {
      const test = getTestByTestId(dispatcher, testId)

      const isTimeout = status === 'timedOut'
      testEndHandler(test, annotations, STATUS_TO_TEST_STATUS[status], errors && errors[0], isTimeout)
    })

    return worker
  })
  return dispatcherExport
}

function runnerHook (runnerExport, playwrightVersion) {
  shimmer.wrap(runnerExport.Runner.prototype, 'runAllTests', runAllTests => async function () {
    const testSessionAsyncResource = new AsyncResource('bound-anonymous-fn')
    const rootDir = getRootDir(this)

    const processArgv = process.argv.slice(2).join(' ')
    const command = `playwright ${processArgv}`
    testSessionAsyncResource.runInAsyncScope(() => {
      testSessionStartCh.publish({ command, frameworkVersion: playwrightVersion, rootDir })
    })
    const projects = getProjectsFromRunner(this)

    const runAllTestsReturn = await runAllTests.apply(this, arguments)

    Object.values(remainingTestsByFile).forEach(tests => {
      // `tests` should normally be empty, but if it isn't,
      // there were tests that did not go through `testBegin` or `testEnd`,
      // because they were skipped
      tests.forEach(test => {
        const browser = getBrowserNameFromProjects(projects, test)
        testBeginHandler(test, browser)
        testEndHandler(test, [], 'skip')
      })
    })

    const sessionStatus = runAllTestsReturn.status || runAllTestsReturn

    let onDone
    const flushWait = new Promise(resolve => {
      onDone = resolve
    })
    testSessionAsyncResource.runInAsyncScope(() => {
      testSessionFinishCh.publish({ status: STATUS_TO_TEST_STATUS[sessionStatus], onDone })
    })
    await flushWait

    startedSuites = []
    remainingTestsByFile = {}

    return runAllTestsReturn
  })

  return runnerExport
}

addHook({
  name: '@playwright/test',
  file: 'lib/runner.js',
  versions: ['>=1.18.0 <=1.30.0']
}, runnerHook)

addHook({
  name: '@playwright/test',
  file: 'lib/dispatcher.js',
  versions: ['>=1.18.0 <1.30.0']
}, dispatcherHook)

addHook({
  name: '@playwright/test',
  file: 'lib/dispatcher.js',
  versions: ['>=1.30.0 <1.31.0']
}, (dispatcher) => dispatcherHookNew(dispatcher, dispatcherRunWrapper))

addHook({
  name: '@playwright/test',
  file: 'lib/runner/dispatcher.js',
  versions: ['>=1.31.0 <1.38.0']
}, (dispatcher) => dispatcherHookNew(dispatcher, dispatcherRunWrapperNew))

addHook({
  name: '@playwright/test',
  file: 'lib/runner/runner.js',
  versions: ['>=1.31.0 <1.38.0']
}, runnerHook)

// From >=1.38.0
addHook({
  name: 'playwright',
  file: 'lib/runner/runner.js',
  versions: ['>=1.38.0']
}, runnerHook)

addHook({
  name: 'playwright',
  file: 'lib/runner/dispatcher.js',
  versions: ['>=1.38.0']
}, (dispatcher) => dispatcherHookNew(dispatcher, dispatcherRunWrapperNew))
