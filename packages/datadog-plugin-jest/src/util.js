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

module.exports = { getFormattedJestTestParameters, getJestTestName }
