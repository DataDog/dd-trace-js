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
  typeAndDefinitionChecks,
  isDefined,
  compileTimeErrors
} = require('./condition-test-cases')
const compile = require('../../../src/debugger/devtools_client/condition')

// Each test case is a tuple of [ast, data, expected] where:
// - `ast` is the abstract syntax tree to be compiled
// - `data` is an object mapping variable names to their values
// - `expected` is the expected result of the compiled expression
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

// Each test case is a tuple of [ast, suffix, expected] where:
// - `ast` is the abstract syntax tree to be compiled
// - `suffix` is a suffix expression to be appended to the compiled code (variables defined after the compiled code)
// - `expected` is the expected result of the compiled code
const isDefinedTestCases = [
  ...isDefined
]

// Each test case is a tuple of [ast, data, expected] where:
// - `ast` is the abstract syntax tree to be compiled
// - `data` is an object mapping variable names to their values
// - `expected` is the expected error when compiling the expression
const compileTimeErrorTestCases = [
  ...compileTimeErrors
]

describe('Expresion language condition compilation', function () {
  before(() => {
    // Mock the presence of `isProxy` as it would be available when DI is active in the tracer
    process[Symbol.for('datadog:isProxy')] = require('util').types.isProxy
  })

  for (const [ast, data, expected] of testCases) {
    it(generateTestCaseName(ast, data, expected), function () {
      const fn = new Function(...Object.keys(data), `return ${compile(ast)}`) // eslint-disable-line no-new-func
      const args = Object.values(data)
      if (expected instanceof Error) {
        expect(() => fn(...args)).to.throw(expected.constructor, expected.message)
      } else {
        const result = runWithDebug(fn, args)
        if (typeof expected === 'object') {
          expect(result).to.deep.equal(expected)
        } else {
          expect(result).to.equal(expected)
        }
      }
    })
  }

  for (const [ast, suffix, expected] of isDefinedTestCases) {
    it(generateTestCaseName(ast, suffix, expected), function () {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`
        const result = (() => {
          return ${compile(ast)}
        })()
        ${suffix}
        return result
      `)
      const result = runWithDebug(fn)
      expect(result).to.equal(expected)
    })
  }

  for (const [ast, data, expected] of compileTimeErrorTestCases) {
    it(generateTestCaseName(ast, data, expected), function () {
      expect(() => compile(ast)).to.throw(expected.constructor, expected.message)
    })
  }

  it('should abort if isProxy is not available on the global scope', function () {
    process[Symbol.for('datadog:isProxy')] = undefined
    const ast = { getmember: [{ ref: 'proxy' }, 'foo'] }
    const fn = new Function('proxy', `return ${compile(ast)}`) // eslint-disable-line no-new-func
    expect(fn).to.throw(Error, 'Possibility of side effect')
  })
})

function generateTestCaseName (ast, dataOrSuffix, expected) {
  const code = typeof dataOrSuffix === 'string'
    ? JSON.stringify(dataOrSuffix)
    : Object
      .entries(dataOrSuffix)
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
      .join('; ')

  return `${JSON.stringify(ast)} + "${code}" = ${expected}`
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
