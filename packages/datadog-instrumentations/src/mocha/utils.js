const {
  getTestSuitePath,
  removeEfdStringFromTestName,
  addEfdStringToTestName
} = require('../../../dd-trace/src/plugins/util/test')

function isNewTest (test, knownTests) {
  const testSuite = getTestSuitePath(test.file, process.cwd())
  const testName = removeEfdStringFromTestName(test.fullTitle())
  const testsForSuite = knownTests.mocha?.[testSuite] || []
  return !testsForSuite.includes(testName)
}

function retryTest (test, earlyFlakeDetectionNumRetries) {
  const originalTestName = test.title
  const suite = test.parent
  for (let retryIndex = 0; retryIndex < earlyFlakeDetectionNumRetries; retryIndex++) {
    const clonedTest = test.clone()
    clonedTest.title = addEfdStringToTestName(originalTestName, retryIndex + 1)
    suite.addTest(clonedTest)
    clonedTest._ddIsNew = true
    clonedTest._ddIsEfdRetry = true
  }
}

function getSuitesByTestFile (root) {
  const suitesByTestFile = {}
  function getSuites (suite) {
    if (suite.file) {
      if (suitesByTestFile[suite.file]) {
        suitesByTestFile[suite.file].push(suite)
      } else {
        suitesByTestFile[suite.file] = [suite]
      }
    }
    suite.suites.forEach(suite => {
      getSuites(suite)
    })
  }
  getSuites(root)

  const numSuitesByTestFile = Object.keys(suitesByTestFile).reduce((acc, testFile) => {
    acc[testFile] = suitesByTestFile[testFile].length
    return acc
  }, {})

  return { suitesByTestFile, numSuitesByTestFile }
}

function isMochaRetry (test) {
  return test._currentRetry !== undefined && test._currentRetry !== 0
}

function getTestFullName (test) {
  return `mocha.${getTestSuitePath(test.file, process.cwd())}.${removeEfdStringFromTestName(test.fullTitle())}`
}

function getTestStatus (test) {
  if (test.isPending()) {
    return 'skip'
  }
  if (test.isFailed() || test.timedOut) {
    return 'fail'
  }
  return 'pass'
}

module.exports = {
  isNewTest,
  retryTest,
  getSuitesByTestFile,
  isMochaRetry,
  getTestFullName,
  getTestStatus
}
