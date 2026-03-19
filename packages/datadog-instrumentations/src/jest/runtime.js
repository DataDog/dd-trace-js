'use strict'

const path = require('path')
const shimmer = require('../../../datadog-shimmer')
const { addHook } = require('../helpers/instrument')
const {
  testSuiteErrorCh,
} = require('./channels')
const {
  testSuiteAbsolutePathsWithFastCheck,
  testSuiteJestObjects,
  testSuiteMockedFiles,
} = require('./state')

const LIBRARIES_BYPASSING_JEST_REQUIRE_ENGINE = new Set([
  'selenium-webdriver',
  'selenium-webdriver/chrome',
  'selenium-webdriver/edge',
  'selenium-webdriver/safari',
  'selenium-webdriver/firefox',
  'selenium-webdriver/ie',
  'selenium-webdriver/chromium',
  'winston',
])

addHook({
  name: 'jest-runtime',
  versions: ['>=24.8.0'],
}, (runtimePackage) => {
  const Runtime = runtimePackage.default ?? runtimePackage

  shimmer.wrap(Runtime.prototype, '_createJestObjectFor', _createJestObjectFor => function (from) {
    const result = _createJestObjectFor.apply(this, arguments)
    const suiteFilePath = this._testPath || from

    // Store the jest object so we can access it later for resetting mock state
    if (suiteFilePath) {
      testSuiteJestObjects.set(suiteFilePath, result)
    }

    shimmer.wrap(result, 'mock', mock => function (moduleName) {
      // If the library is mocked with `jest.mock`, we don't want to bypass jest's own require engine
      if (LIBRARIES_BYPASSING_JEST_REQUIRE_ENGINE.has(moduleName)) {
        LIBRARIES_BYPASSING_JEST_REQUIRE_ENGINE.delete(moduleName)
      }
      if (suiteFilePath) {
        const existingMockedFiles = testSuiteMockedFiles.get(suiteFilePath) || []
        const suiteDir = path.dirname(suiteFilePath)
        const mockPath = path.resolve(suiteDir, moduleName)
        existingMockedFiles.push(mockPath)
        testSuiteMockedFiles.set(suiteFilePath, existingMockedFiles)
      }
      return mock.apply(this, arguments)
    })
    return result
  })

  shimmer.wrap(Runtime.prototype, 'requireModuleOrMock', requireModuleOrMock => function (from, moduleName) {
    // `requireModuleOrMock` may log errors to the console. If we don't remove ourselves
    // from the stack trace, the user might see a useless stack trace rather than the error
    // that `jest` tries to show.
    const originalPrepareStackTrace = Error.prepareStackTrace
    Error.prepareStackTrace = function (error, structuredStackTrace) {
      const filteredStackTrace = structuredStackTrace
        .filter(callSite => !callSite.getFileName()?.includes('datadog-instrumentations/src/jest/'))

      return originalPrepareStackTrace(error, filteredStackTrace)
    }
    try {
      // TODO: do this for every library that we instrument
      if (LIBRARIES_BYPASSING_JEST_REQUIRE_ENGINE.has(moduleName)) {
        // To bypass jest's own require engine
        return this._requireCoreModule(moduleName)
      }
      // This means that `@fast-check/jest` is used in the test file.
      if (moduleName === '@fast-check/jest') {
        testSuiteAbsolutePathsWithFastCheck.add(this._testPath)
      }
      const returnedValue = requireModuleOrMock.apply(this, arguments)
      if (process.exitCode === 1) {
        if (this.loggedReferenceErrors?.size > 0) {
          const errorMessage = [...this.loggedReferenceErrors][0]
          testSuiteErrorCh.publish({
            errorMessage,
            testSuiteAbsolutePath: this._testPath,
          })
        } else {
          testSuiteErrorCh.publish({
            errorMessage: 'An error occurred while importing a module',
            testSuiteAbsolutePath: this._testPath,
          })
        }
      }
      return returnedValue
    } finally {
      // Restore original prepareStackTrace
      Error.prepareStackTrace = originalPrepareStackTrace
    }
  })

  return runtimePackage
})
