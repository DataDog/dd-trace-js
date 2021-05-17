const { getGitMetadata, GIT_BRANCH, GIT_COMMIT_SHA, GIT_REPOSITORY_URL, GIT_TAG } = require('./git')
const { getCIMetadata } = require('./ci')
const { getRuntimeAndOSMetadata } = require('./env')

const TEST_FRAMEWORK = 'test.framework'
const TEST_TYPE = 'test.type'
const TEST_NAME = 'test.name'
const TEST_SUITE = 'test.suite'
const TEST_STATUS = 'test.status'
const TEST_PARAMETERS = 'test.parameters'

const ERROR_TYPE = 'error.type'
const ERROR_MESSAGE = 'error.message'
const ERROR_STACK = 'error.stack'

module.exports = {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  TEST_PARAMETERS,
  ERROR_TYPE,
  ERROR_MESSAGE,
  ERROR_STACK,
  getTestEnvironmentMetadata,
  getTestParametersString,
  getFormattedJestTestParameters
}

function getTestEnvironmentMetadata (testFramework) {
  // TODO: eventually these will come from the tracer (generally available)
  const ciMetadata = getCIMetadata()
  const {
    [GIT_COMMIT_SHA]: commitSHA,
    [GIT_BRANCH]: branch,
    [GIT_REPOSITORY_URL]: repositoryUrl,
    [GIT_TAG]: tag
  } = ciMetadata

  const gitMetadata = getGitMetadata({ commitSHA, branch, repositoryUrl, tag })

  const runtimeAndOSMetadata = getRuntimeAndOSMetadata()

  return {
    [TEST_FRAMEWORK]: testFramework,
    ...gitMetadata,
    ...ciMetadata,
    ...runtimeAndOSMetadata
  }
}

function getTestParametersString (parametersByTestName, testName) {
  if (!parametersByTestName[testName]) {
    return ''
  }
  try {
    // test is invoked with each parameter set sequencially
    const testParameters = parametersByTestName[testName].shift()
    return JSON.stringify({ arguments: testParameters, metadata: {} })
  } catch (e) {
    // We can't afford to interrupt the test if `testParameters` is not serializable to JSON,
    // so we ignore the test parameters and move on
    return ''
  }
}

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
