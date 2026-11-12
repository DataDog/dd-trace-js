'use strict'

const { getTestSuitePath, isMarkedAsUnskippable } = require('./test')

/**
 * There are two ways to call `test.each` in `jest`:
 * 1. With an array of arrays: https://jestjs.io/docs/api#1-testeachtablename-fn-timeout
 * 2. With a tagged template literal: https://jestjs.io/docs/api#2-testeachtablename-fn-timeout
 * This function distinguishes between the two and returns the test parameters in different formats:
 * 1. An array of arrays with the different parameters to the test, e.g.
 * [[1, 2, 3], [2, 3, 5]]
 * 2. An array of objects, e.g.
 * [{ a: 1, b: 2, expected: 3 }, { a: 2, b: 3, expected: 5}]
 *
 * @param {unknown[]} testParameters `test.each` arguments
 */
function getFormattedJestTestParameters (testParameters) {
  if (!testParameters || !testParameters.length) {
    return
  }
  const [parameterArray, ...parameterValues] = testParameters
  if (parameterValues.length === 0) { // Way 1.
    return parameterArray
  }
  // Way 2.
  const parameterKeys = parameterArray[0].split('|').map(key => key.trim())
  const formattedParameters = []
  let lastFormattedParameter = {}
  for (let index = 0; index < parameterValues.length; index++) {
    const parameterIndex = index % parameterKeys.length
    if (parameterIndex === 0) {
      lastFormattedParameter = {}
      formattedParameters.push(lastFormattedParameter)
    }
    const key = parameterKeys[parameterIndex]
    lastFormattedParameter[key] = parameterValues[index]
  }

  return formattedParameters
}

// @fast-check/jest appends a random seed to the reported test name. A test name that keeps changing
// breaks some Test Optimization features, so normalize this narrow suffix regardless of import style.
// fast-check emits exactly one space before the suffix.
const SEED_SUFFIX_RE = / ?\(with seed=-?\d+\) ?$/i

function removeSeedSuffixFromTestName (testName) {
  return testName.replace(SEED_SUFFIX_RE, '')
}

// https://github.com/facebook/jest/blob/3e38157ad5f23fb7d24669d24fae8ded06a7ab75/packages/jest-circus/src/utils.ts#L396
function getRawJestTestName (test) {
  const titles = []
  let parent = test
  do {
    titles.unshift(parent.name)
  } while ((parent = parent.parent))

  titles.shift() // remove TOP_DESCRIBE_BLOCK_NAME

  return titles.join(' ')
}

function getJestTestName (test) {
  return removeSeedSuffixFromTestName(getRawJestTestName(test))
}

function getJestSuitesToRun (skippableSuites, originalTests, rootDir, fallbackRootDir) {
  const unskippableSuites = {}
  const forcedToRunSuites = {}
  let hasUnskippableSuites = false
  let hasForcedToRunSuites = false

  const skippedSuites = []
  const suitesToRun = []
  const normalizedSkippableSuites = new Set(skippableSuites.map(suite => suite.replaceAll('\\', '/')))

  for (const test of originalTests) {
    const relativePath = getTestSuitePath(test.path, rootDir)
    const testRootDir = test?.context?.config?.rootDir || fallbackRootDir
    let fallbackRelativePath
    let skippedSuite = normalizedSkippableSuites.has(relativePath) ? relativePath : undefined
    if (testRootDir && testRootDir !== rootDir) {
      fallbackRelativePath = getTestSuitePath(test.path, testRootDir)
      if (skippedSuite === undefined && normalizedSkippableSuites.has(fallbackRelativePath)) {
        skippedSuite = fallbackRelativePath
      }
    }
    if (isMarkedAsUnskippable(test)) {
      suitesToRun.push(test)
      unskippableSuites[relativePath] = true
      hasUnskippableSuites = true
      if (fallbackRelativePath !== undefined) {
        unskippableSuites[fallbackRelativePath] = true
      }
      if (skippedSuite !== undefined) {
        forcedToRunSuites[relativePath] = true
        hasForcedToRunSuites = true
        if (fallbackRelativePath !== undefined) {
          forcedToRunSuites[fallbackRelativePath] = true
        }
      }
      continue
    }
    if (skippedSuite === undefined) {
      suitesToRun.push(test)
    } else {
      skippedSuites.push(skippedSuite)
    }
  }

  if (originalTests.length) {
    // The config object is shared by all tests, so we can just take the first one
    const [test] = originalTests
    if (test?.context?.config?.testEnvironmentOptions) {
      if (hasUnskippableSuites) {
        test.context.config.testEnvironmentOptions._ddUnskippable = JSON.stringify(unskippableSuites)
      }
      if (hasForcedToRunSuites) {
        test.context.config.testEnvironmentOptions._ddForcedToRun = JSON.stringify(forcedToRunSuites)
      }
    }
  }

  return {
    skippedSuites,
    suitesToRun,
    hasUnskippableSuites,
    hasForcedToRunSuites,
  }
}

module.exports = {
  SEED_SUFFIX_RE,
  getFormattedJestTestParameters,
  getJestTestName,
  getRawJestTestName,
  getJestSuitesToRun,
  removeSeedSuffixFromTestName,
}
