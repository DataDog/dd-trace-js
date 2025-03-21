const satisfies = require('semifies')

const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { parseAnnotations, getTestSuitePath } = require('../../dd-trace/src/plugins/util/test')
const log = require('../../dd-trace/src/log')

const testStartCh = channel('ci:playwright:test:start')
const testFinishCh = channel('ci:playwright:test:finish')

const testSessionStartCh = channel('ci:playwright:session:start')
const testSessionFinishCh = channel('ci:playwright:session:finish')

const libraryConfigurationCh = channel('ci:playwright:library-configuration')
const knownTestsCh = channel('ci:playwright:known-tests')
const testManagementTestsCh = channel('ci:playwright:test-management-tests')

const testSuiteStartCh = channel('ci:playwright:test-suite:start')
const testSuiteFinishCh = channel('ci:playwright:test-suite:finish')

const testToAr = new WeakMap()
const testSuiteToAr = new Map()
const testSuiteToTestStatuses = new Map()
const testSuiteToErrors = new Map()
const testSessionAsyncResource = new AsyncResource('bound-anonymous-fn')

let applyRepeatEachIndex = null

let startedSuites = []

const STATUS_TO_TEST_STATUS = {
  passed: 'pass',
  failed: 'fail',
  timedOut: 'fail',
  skipped: 'skip'
}

let remainingTestsByFile = {}
let isKnownTestsEnabled = false
let isEarlyFlakeDetectionEnabled = false
let earlyFlakeDetectionNumRetries = 0
let isFlakyTestRetriesEnabled = false
let flakyTestRetriesCount = 0
let knownTests = {}
let isTestManagementTestsEnabled = false
let testManagementTests = {}
let rootDir = ''
const MINIMUM_SUPPORTED_VERSION_RANGE_EFD = '>=1.38.0'

function getTestProperties (test) {
  const testName = getTestFullname(test)
  const testSuite = getTestSuitePath(test._requireFile, rootDir)

  const { disabled, quarantined } =
    testManagementTests?.playwright?.suites?.[testSuite]?.tests?.[testName]?.properties || {}

  return { disabled, quarantined }
}

function isNewTest (test) {
  const testSuite = getTestSuitePath(test._requireFile, rootDir)
  const testsForSuite = knownTests?.playwright?.[testSuite] || []

  return !testsForSuite.includes(getTestFullname(test))
}

function getSuiteType (test, type) {
  let suite = test.parent
  while (suite && suite._type !== type) {
    suite = suite.parent
  }
  return suite
}

// Copy of Suite#_deepClone but with a function to filter tests
function deepCloneSuite (suite, filterTest) {
  const copy = suite._clone()
  for (const entry of suite._entries) {
    if (entry.constructor.name === 'Suite') {
      copy._addSuite(deepCloneSuite(entry, filterTest))
    } else {
      if (filterTest(entry)) {
        const copiedTest = entry._clone()
        copiedTest._ddIsNew = true
        copiedTest._ddIsEfdRetry = true
        copy._addTest(copiedTest)
      }
    }
  }
  return copy
}

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

function getTestByTestId (dispatcher, testId) {
  if (dispatcher._testById) {
    return dispatcher._testById.get(testId)?.test
  }
  const allTests = dispatcher._allTests || dispatcher._ddAllTests
  if (allTests) {
    return allTests.find(({ id }) => id === testId)
  }
}

function getChannelPromise (channelToPublishTo) {
  return new Promise(resolve => {
    testSessionAsyncResource.runInAsyncScope(() => {
      channelToPublishTo.publish({ onDone: resolve })
    })
  })
}
// eslint-disable-next-line
// Inspired by https://github.com/microsoft/playwright/blob/2b77ed4d7aafa85a600caa0b0d101b72c8437eeb/packages/playwright/src/reporters/base.ts#L293
// We can't use test.outcome() directly because it's set on follow up handlers:
// our `testEndHandler` is called before the outcome is set.
function testWillRetry (test, testStatus) {
  return testStatus === 'fail' && test.results.length <= test.retries
}

function getTestFullname (test) {
  let parent = test.parent
  const names = [test.title]
  while (parent?._type === 'describe' || parent?._isDescribe) {
    if (parent.title) {
      names.unshift(parent.title)
    }
    parent = parent.parent
  }
  return names.join(' ')
}

function testBeginHandler (test, browserName) {
  const {
    _requireFile: testSuiteAbsolutePath,
    _type,
    location: {
      line: testSourceLine
    }
  } = test

  if (_type === 'beforeAll' || _type === 'afterAll') {
    return
  }

  const testName = getTestFullname(test)

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
    testStartCh.publish({
      testName,
      testSuiteAbsolutePath,
      testSourceLine,
      browserName,
      isDisabled: test._ddIsDisabled
    })
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
    testFinishCh.publish({
      testStatus,
      steps: testResult?.steps || [],
      isRetry: testResult?.retry > 0,
      error,
      extraTags: annotationTags,
      isNew: test._ddIsNew,
      isQuarantined: test._ddIsQuarantined,
      isEfdRetry: test._ddIsEfdRetry
    })
  })

  if (testSuiteToTestStatuses.has(testSuiteAbsolutePath)) {
    testSuiteToTestStatuses.get(testSuiteAbsolutePath).push(testStatus)
  } else {
    testSuiteToTestStatuses.set(testSuiteAbsolutePath, [testStatus])
  }

  if (error) {
    addErrorToTestSuite(testSuiteAbsolutePath, error)
  }

  if (!testWillRetry(test, testStatus)) {
    remainingTestsByFile[testSuiteAbsolutePath] = remainingTestsByFile[testSuiteAbsolutePath]
      .filter(currentTest => currentTest !== test)
  }

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
  return function (testGroups) {
    if (!this._allTests) {
      // Removed in https://github.com/microsoft/playwright/commit/1e52c37b254a441cccf332520f60225a5acc14c7
      // Not available from >=1.44.0
      this._ddAllTests = testGroups.map(g => g.tests).flat()
    }
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
    let onDone

    rootDir = getRootDir(this)

    const processArgv = process.argv.slice(2).join(' ')
    const command = `playwright ${processArgv}`
    testSessionAsyncResource.runInAsyncScope(() => {
      testSessionStartCh.publish({ command, frameworkVersion: playwrightVersion, rootDir })
    })

    try {
      const { err, libraryConfig } = await getChannelPromise(libraryConfigurationCh)
      if (!err) {
        isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
        isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
        earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries
        isFlakyTestRetriesEnabled = libraryConfig.isFlakyTestRetriesEnabled
        flakyTestRetriesCount = libraryConfig.flakyTestRetriesCount
        isTestManagementTestsEnabled = libraryConfig.isTestManagementEnabled
      }
    } catch (e) {
      isEarlyFlakeDetectionEnabled = false
      isKnownTestsEnabled = false
      isTestManagementTestsEnabled = false
      log.error('Playwright session start error', e)
    }

    if (isKnownTestsEnabled && satisfies(playwrightVersion, MINIMUM_SUPPORTED_VERSION_RANGE_EFD)) {
      try {
        const { err, knownTests: receivedKnownTests } = await getChannelPromise(knownTestsCh)
        if (!err) {
          knownTests = receivedKnownTests
        } else {
          isEarlyFlakeDetectionEnabled = false
          isKnownTestsEnabled = false
        }
      } catch (err) {
        isEarlyFlakeDetectionEnabled = false
        isKnownTestsEnabled = false
        log.error('Playwright known tests error', err)
      }
    }

    if (isTestManagementTestsEnabled && satisfies(playwrightVersion, MINIMUM_SUPPORTED_VERSION_RANGE_EFD)) {
      try {
        const { err, testManagementTests: receivedTestManagementTests } = await getChannelPromise(testManagementTestsCh)
        if (!err) {
          testManagementTests = receivedTestManagementTests
        } else {
          isTestManagementTestsEnabled = false
        }
      } catch (err) {
        isTestManagementTestsEnabled = false
        log.error('Playwright test management tests error', err)
      }
    }

    const projects = getProjectsFromRunner(this)

    if (isFlakyTestRetriesEnabled && flakyTestRetriesCount > 0) {
      projects.forEach(project => {
        if (project.retries === 0) { // Only if it hasn't been set by the user
          project.retries = flakyTestRetriesCount
        }
      })
    }

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

    const flushWait = new Promise(resolve => {
      onDone = resolve
    })
    testSessionAsyncResource.runInAsyncScope(() => {
      testSessionFinishCh.publish({
        status: STATUS_TO_TEST_STATUS[sessionStatus],
        isEarlyFlakeDetectionEnabled,
        isTestManagementTestsEnabled,
        onDone
      })
    })
    await flushWait

    startedSuites = []
    remainingTestsByFile = {}

    // TODO: we can trick playwright into thinking the session passed by returning
    // 'passed' here. We might be able to use this for both EFD and Test Management tests.
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

// Hook used for early flake detection. EFD only works from >=1.38.0
addHook({
  name: 'playwright',
  file: 'lib/common/suiteUtils.js',
  versions: [MINIMUM_SUPPORTED_VERSION_RANGE_EFD]
}, suiteUtilsPackage => {
  // We grab `applyRepeatEachIndex` to use it later
  // `applyRepeatEachIndex` needs to be applied to a cloned suite
  applyRepeatEachIndex = suiteUtilsPackage.applyRepeatEachIndex
  return suiteUtilsPackage
})

// Hook used for early flake detection. EFD only works from >=1.38.0
addHook({
  name: 'playwright',
  file: 'lib/runner/loadUtils.js',
  versions: [MINIMUM_SUPPORTED_VERSION_RANGE_EFD]
}, (loadUtilsPackage) => {
  const oldCreateRootSuite = loadUtilsPackage.createRootSuite

  async function newCreateRootSuite () {
    if (!isKnownTestsEnabled && !isTestManagementTestsEnabled) {
      return oldCreateRootSuite.apply(this, arguments)
    }
    const rootSuite = await oldCreateRootSuite.apply(this, arguments)

    const allTests = rootSuite.allTests()

    if (isTestManagementTestsEnabled) {
      for (const test of allTests) {
        const testProperties = getTestProperties(test)
        if (testProperties.disabled) {
          test._ddIsDisabled = true
          test.expectedStatus = 'skipped'
        } else if (testProperties.quarantined) {
          test._ddIsQuarantined = true
          test.expectedStatus = 'skipped'
        }
      }
    }

    if (isKnownTestsEnabled) {
      const newTests = allTests.filter(isNewTest)

      newTests.forEach(newTest => {
        newTest._ddIsNew = true
        if (isEarlyFlakeDetectionEnabled && newTest.expectedStatus !== 'skipped') {
          const fileSuite = getSuiteType(newTest, 'file')
          const projectSuite = getSuiteType(newTest, 'project')
          for (let repeatEachIndex = 0; repeatEachIndex < earlyFlakeDetectionNumRetries; repeatEachIndex++) {
            const copyFileSuite = deepCloneSuite(fileSuite, isNewTest)
            applyRepeatEachIndex(projectSuite._fullProject, copyFileSuite, repeatEachIndex + 1)
            projectSuite._addSuite(copyFileSuite)
          }
        }
      })
    }

    return rootSuite
  }

  loadUtilsPackage.createRootSuite = newCreateRootSuite

  return loadUtilsPackage
})
