const { readFileSync } = require('fs')
const { parse, extract } = require('jest-docblock')

const { getTestSuitePath } = require('../../dd-trace/src/plugins/util/test')
const log = require('../../dd-trace/src/log')

/**
 * There are two ways to call `test.each` in `jest`:
 * 1. With an array of arrays: https://jestjs.io/docs/api#1-testeachtablename-fn-timeout
 * 2. With a tagged template literal: https://jestjs.io/docs/api#2-testeachtablename-fn-timeout
 * This function distinguishes between the two and returns the test parameters in different formats:
 * 1. An array of arrays with the different parameters to the test, e.g.
 * [[1, 2, 3], [2, 3, 5]]
 * 2. An array of objects, e.g.
 * [{ a: 1, b: 2, expected: 3 }, { a: 2, b: 3, expected: 5}]
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
  for (let index = 0; index < parameterValues.length; index++) {
    const parameterValue = parameterValues[index]
    const parameterIndex = index % parameterKeys.length
    if (!parameterIndex) {
      formattedParameters.push({})
    }
    const parameterKey = parameterKeys[parameterIndex]
    const lastFormattedParameter = formattedParameters[formattedParameters.length - 1]
    lastFormattedParameter[parameterKey] = parameterValue
  }

  return formattedParameters
}

// https://github.com/facebook/jest/blob/3e38157ad5f23fb7d24669d24fae8ded06a7ab75/packages/jest-circus/src/utils.ts#L396
function getJestTestName (test) {
  const titles = []
  let parent = test
  do {
    titles.unshift(parent.name)
  } while ((parent = parent.parent))

  titles.shift() // remove TOP_DESCRIBE_BLOCK_NAME
  return titles.join(' ')
}

function isMarkedAsUnskippable (test) {
  let docblocks

  try {
    const testSource = readFileSync(test.path, 'utf8')
    docblocks = parse(extract(testSource))
  } catch (e) {
    // If we have issues parsing the file, we'll assume no unskippable was passed
    return false
  }

  // docblocks were correctly parsed but it does not include a @datadog block
  if (!docblocks?.datadog) {
    return false
  }

  try {
    return JSON.parse(docblocks.datadog).unskippable
  } catch (e) {
    // If the @datadog block comment is present but malformed, we'll run the suite
    log.warn('@datadog block comment is malformed.')
    return true
  }
}

function getJestSuitesToRun (skippableSuites, originalTests, rootDir) {
  const unskippableSuites = {}
  const forcedToRunSuites = {}

  const skippedSuites = []
  const suitesToRun = []

  for (const test of originalTests) {
    const relativePath = getTestSuitePath(test.path, rootDir)
    const shouldBeSkipped = skippableSuites.includes(relativePath)
    if (isMarkedAsUnskippable(test)) {
      suitesToRun.push(test)
      unskippableSuites[relativePath] = true
      if (shouldBeSkipped) {
        forcedToRunSuites[relativePath] = true
      }
      continue
    }
    if (shouldBeSkipped) {
      skippedSuites.push(relativePath)
    } else {
      suitesToRun.push(test)
    }
  }

  const hasUnskippableSuites = Object.keys(unskippableSuites).length > 0
  const hasForcedToRunSuites = Object.keys(forcedToRunSuites).length > 0

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
    hasForcedToRunSuites
  }
}

module.exports = { getFormattedJestTestParameters, getJestTestName, getJestSuitesToRun, isMarkedAsUnskippable }
