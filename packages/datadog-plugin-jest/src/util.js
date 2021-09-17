const { SAMPLING_RULE_DECISION } = require('../../dd-trace/src/constants')
const { SAMPLING_PRIORITY, SPAN_TYPE } = require('../../../ext/tags')
const { AUTO_KEEP } = require('../../../ext/priority')
const { TEST_TYPE, TEST_STATUS, getTestParentSpan } = require('../../dd-trace/src/plugins/util/test')

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

function getTestSpanTags (tracer, testEnvironmentMetadata) {
  const childOf = getTestParentSpan(tracer)

  const commonSpanTags = {
    [TEST_TYPE]: 'test',
    [SAMPLING_RULE_DECISION]: 1,
    [SAMPLING_PRIORITY]: AUTO_KEEP,
    [SPAN_TYPE]: 'test',
    ...testEnvironmentMetadata
  }
  return {
    childOf,
    commonSpanTags
  }
}

function setSuppressedErrors (suppressedErrors, testSpan) {
  if (suppressedErrors && suppressedErrors.length) {
    testSpan.setTag('error', suppressedErrors[0])
    testSpan.setTag(TEST_STATUS, 'fail')
  }
}

module.exports = { getFormattedJestTestParameters, getTestSpanTags, setSuppressedErrors }
