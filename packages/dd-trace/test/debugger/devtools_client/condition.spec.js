'use strict'

require('../../setup/mocha')

const {
  literals,
  references,
  propertyAccess,
  sizes,
  equality,
  stringManipulation,
  stringComparison,
  logicalOperators,
  collectionOperations,
  membershipAndMatching,
  typeAndDefinitionChecks
} = require('./condition-test-cases')
const compile = require('../../../src/debugger/devtools_client/condition')

// Each test case is either a tuple of [ast, vars, expected] where:
// - `ast` is the abstract syntax tree to be compiled
// - `vars` is an object mapping variable names to their values
// - `expected` is the expected result of the compiled expression
// or an object with the following possible properties:
// - `before` is a function to be called before the test case
// - `ast` is the abstract syntax tree to be compiled
// - `vars` is an object mapping variable names to their values
// - `suffix` is a string to be appended to the compiled expression
// - `expected` is the expected result of the compiled expression
// - `execute` is a boolean indicating whether the compiled code should be executed
const testCases = [
  ...literals,
  ...references,
  ...propertyAccess,
  ...sizes,
  ...equality,
  ...stringManipulation,
  ...stringComparison,
  ...logicalOperators,
  ...collectionOperations,
  ...membershipAndMatching,
  ...typeAndDefinitionChecks
]

describe('Expresion language condition compilation', function () {
  beforeEach(() => {
    // Mock the presence of `util.types` as it would be available when DI is active in the tracer
    process[Symbol.for('datadog:node:util:types')] = require('util').types
  })

  for (const testCase of testCases) {
    let before, ast, vars, suffix, expected, execute
    if (Array.isArray(testCase)) {
      [ast, vars, expected] = testCase
    } else {
      // Allow for more expressive test cases in situations where the default tuple is not enough
      ({ before, ast, vars = {}, suffix, expected, execute = true } = testCase)
    }

    it(generateTestCaseName(ast, vars, expected), function () {
      if (before) {
        before()
      }

      if (execute === false) {
        if (expected instanceof Error) {
          expect(() => compile(ast)).to.throw(expected.constructor, expected.message)
        } else {
          expect(compile(ast)).to.equal(expected)
        }
        return
      }

      const code = suffix
        ? `const result = (() => {
            return ${compile(ast)}
          })()
          ${suffix}
          return result`
        : `return ${compile(ast)}`
      const fn = new Function(...Object.keys(vars), code) // eslint-disable-line no-new-func
      const args = Object.values(vars)

      if (expected instanceof Error) {
        expect(() => fn(...args)).to.throw(expected.constructor, expected.message)
      } else {
        const result = runWithDebug(fn, args)
        if (expected !== null && typeof expected === 'object') {
          expect(result).to.deep.equal(expected)
        } else {
          expect(result).to.equal(expected)
        }
      }
    })
  }
})

function generateTestCaseName (ast, dataOrSuffix, expected) {
  const code = typeof dataOrSuffix === 'string'
    ? JSON.stringify(dataOrSuffix)
    : Object
      .entries(dataOrSuffix)
      .map(([key, value]) => `${key} = ${serialize(value)}`)
      .join('; ')

  return `${JSON.stringify(ast)} + "${code}" = ${expected}`
}

function serialize (value) {
  try {
    return JSON.stringify(value)
  } catch (e) {
    // Some values are not serializable to JSON, so we fall back to stringification
    return String(value)
  }
}

function runWithDebug (fn, args = []) {
  try {
    return fn(...args)
  } catch (e) {
    // Output the compiled expression for easier debugging
    // eslint-disable-next-line no-console
    console.log([
      'Compiled expression:',
      '--------------------------------------------------------------------------------',
      fn.toString(),
      '--------------------------------------------------------------------------------'
    ].join('\n'))
    throw e
  }
}
