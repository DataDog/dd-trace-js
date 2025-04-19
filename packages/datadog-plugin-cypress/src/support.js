const path = require('path')

/* eslint-disable */
let isEarlyFlakeDetectionEnabled = false
let isKnownTestsEnabled = false
let knownTestsForSuite = []
let suiteTests = []
let earlyFlakeDetectionNumRetries = 0
let isTestManagementEnabled = false
let testManagementAttemptToFixRetries = 0
let testManagementTests = {}
let isImpactedTestsEnabled = false
let modifiedTests = {}

let repositoryRoot = ''
// We need to grab the original window as soon as possible,
// in case the test changes the origin. If the test does change the origin,
// any call to `cy.window()` will result in a cross origin error.
let originalWindow

// If the test is using multi domain with cy.origin, trying to access
// window properties will result in a cross origin error.
function safeGetRum (window) {
  try {
    return window.DD_RUM
  } catch (e) {
    return null
  }
}

function isNewTest (test) {
  return !knownTestsForSuite.includes(test.fullTitle())
}

function getTestProperties (testName) {
  // We neeed to do it in this way because of compatibility with older versions as '?' is not supported in older versions of Cypress
  const properties = testManagementTests[testName] && testManagementTests[testName].properties || {};

  const { attempt_to_fix: isAttemptToFix, disabled: isDisabled, quarantined: isQuarantined } = properties;

  return { isAttemptToFix, isDisabled, isQuarantined };
}

function retryTest (test, suiteTests, numRetries, tags) {
  for (let retryIndex = 0; retryIndex < numRetries; retryIndex++) {
    const clonedTest = test.clone()
    // TODO: signal in framework logs that this is a retry.
    // TODO: Change it so these tests are allowed to fail.
    // TODO: figure out if reported duration is skewed.
    suiteTests.unshift(clonedTest)
    tags.forEach(tag => {
      clonedTest[tag] = true
    })
  }
}

function getTestEndLine (testFn, startLine) {
  const source = testFn.toString()
  const lineCount = source.split('\n').length
  return startLine + lineCount - 1
}

function getTestSuitePath (testSuiteAbsolutePath, sourceRoot) {
  if (!testSuiteAbsolutePath) {
    return sourceRoot
  }
  const testSuitePath = testSuiteAbsolutePath === sourceRoot
    ? testSuiteAbsolutePath
    : path.relative(sourceRoot, testSuiteAbsolutePath)

  return testSuitePath.replace(path.sep, '/')
}

function isModifiedTest (testPath, testStartLine, testEndLine, modifiedTests) {
  if (modifiedTests !== undefined && !modifiedTests.hasOwnProperty('apiTests')) { // If tests come from the local diff
    const lines = modifiedTests[testPath]
    if (lines) {
      return lines.some(line => line >= testStartLine && line <= testEndLine)
    }
  } else if (modifiedTests && modifiedTests.apiTests !== undefined) { // If tests come from the API
    const isModified = modifiedTests.apiTests.some(file => file === testPath)
    if (isModified) {
      return true
    }
  }
  return false
}


const oldRunTests = Cypress.mocha.getRunner().runTests
Cypress.mocha.getRunner().runTests = function (suite, fn) {
  if (!isKnownTestsEnabled && !isTestManagementEnabled && !isImpactedTestsEnabled) {
    return oldRunTests.apply(this, arguments)
  }
  // We copy the new tests at the beginning of the suite run (runTests), so that they're run
  // multiple times.
  suite.tests.forEach(test => {
    const testName = test.fullTitle()

    const { isAttemptToFix } = getTestProperties(testName)

    if (isTestManagementEnabled) {
      if (isAttemptToFix && !test.isPending()) {
        test._ddIsAttemptToFix = true
        retryTest(test, suite.tests, testManagementAttemptToFixRetries, ['_ddIsAttemptToFix'])
      }
    }
    let isModified = false
    if (isImpactedTestsEnabled) {
      const testPath = getTestSuitePath(test.invocationDetails.absoluteFile, repositoryRoot)
      const testStartLine = test.invocationDetails.line
      const testEndLine = getTestEndLine(test.fn, testStartLine)
      isModified = isModifiedTest(testPath, testStartLine, testEndLine, modifiedTests)
      if (isModified) {
        test._ddIsModified = true
        if (isEarlyFlakeDetectionEnabled && !isAttemptToFix) {
          retryTest(test, suite.tests, earlyFlakeDetectionNumRetries, ['_ddIsModified', '_ddIsEfdRetry'])
        }
      }
    }
    if (isKnownTestsEnabled) {
      if (!test._ddIsNew && !test.isPending() && isNewTest(test)) {
        test._ddIsNew = true
        if (isEarlyFlakeDetectionEnabled && !isAttemptToFix && !isModified) {
          retryTest(test, suite.tests, earlyFlakeDetectionNumRetries, ['_ddIsNew', '_ddIsEfdRetry'])
        }
      }
    }
  })

  return oldRunTests.apply(this, [suite, fn])
}

beforeEach(function () {
  cy.task('dd:beforeEach', {
    testName: Cypress.mocha.getRunner().suite.ctx.currentTest.fullTitle(),
    testSuite: Cypress.mocha.getRootSuite().file
  }).then(({ traceId, shouldSkip }) => {
    Cypress.env('traceId', traceId)
    if (shouldSkip) {
      this.skip()
    }
  })
  cy.window().then(win => {
    originalWindow = win
  })
})

before(function () {
  cy.task('dd:testSuiteStart', {
    testSuite: Cypress.mocha.getRootSuite().file,
    testSuiteAbsolutePath: Cypress.spec && Cypress.spec.absolute
  }).then((suiteConfig) => {
    if (suiteConfig) {
      isEarlyFlakeDetectionEnabled = suiteConfig.isEarlyFlakeDetectionEnabled
      isKnownTestsEnabled = suiteConfig.isKnownTestsEnabled
      knownTestsForSuite = suiteConfig.knownTestsForSuite
      earlyFlakeDetectionNumRetries = suiteConfig.earlyFlakeDetectionNumRetries
      isTestManagementEnabled = suiteConfig.isTestManagementEnabled
      testManagementAttemptToFixRetries = suiteConfig.testManagementAttemptToFixRetries
      testManagementTests = suiteConfig.testManagementTests
      isImpactedTestsEnabled = suiteConfig.isImpactedTestsEnabled
      modifiedTests = suiteConfig.modifiedTests
      repositoryRoot = suiteConfig.repositoryRoot
    }
  })
})

after(() => {
  try {
    if (safeGetRum(originalWindow)) {
      originalWindow.dispatchEvent(new Event('beforeunload'))
    }
  } catch (e) {
    // ignore error. It's usually a multi origin issue.
  }
})


afterEach(function () {
  const currentTest = Cypress.mocha.getRunner().suite.ctx.currentTest
  const testInfo = {
    testName: currentTest.fullTitle(),
    testSuite: Cypress.mocha.getRootSuite().file,
    testSuiteAbsolutePath: Cypress.spec && Cypress.spec.absolute,
    state: currentTest.state,
    error: currentTest.err,
    isNew: currentTest._ddIsNew,
    isEfdRetry: currentTest._ddIsEfdRetry,
    isAttemptToFix: currentTest._ddIsAttemptToFix,
    isModified: currentTest._ddIsModified
  }
  try {
    testInfo.testSourceLine = Cypress.mocha.getRunner().currentRunnable.invocationDetails.line
  } catch (e) {}

  if (safeGetRum(originalWindow)) {
    testInfo.isRUMActive = true
  }
  let coverage
  try {
    coverage = originalWindow.__coverage__
  } catch (e) {
    // ignore error and continue
  }
  cy.task('dd:afterEach', { test: testInfo, coverage })
})
