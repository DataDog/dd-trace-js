'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
require('../../setup/mocha')

const {
  compile,
  compileSegments,
  templateRequiresEvaluation,
} = require('../../../src/debugger/devtools_client/condition')
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
} = require('./condition-test-cases')

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
  ...typeAndDefinitionChecks,
]

describe('Expression language', function () {
  beforeEach(() => {
    // Mock the presence of `util.types` as it would be available when DI is active in the tracer
    globalThis[Symbol.for('dd-trace')].utilTypes ??= require('util').types
  })

  describe('condition compilation', function () {
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
            assert.throws(() => compile(ast), expected.constructor, expected.message)
          } else {
            assert.strictEqual(compile(ast), expected)
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
          assert.throws(() => fn(...args), expected.constructor, expected.message)
        } else {
          const result = runWithDebug(fn, args)
          if (expected !== null && typeof expected === 'object') {
            assert.deepStrictEqual(result, expected)
          } else {
            assert.strictEqual(result, expected)
          }
        }
      })
    }
  })

  describe('templateRequiresEvaluation', function () {
    it('should return false, if the template does not require evaluation', function () {
      assert.strictEqual(templateRequiresEvaluation([{ str: 'foo' }]), false)
      assert.strictEqual(templateRequiresEvaluation([{ str: 'foo' }, { str: 'bar' }]), false)
    })

    it('should return true, if the template requires evaluation', function () {
      assert.strictEqual(templateRequiresEvaluation([{ dsl: '{foo}', json: { ref: 'foo' } }]), true)
      assert.strictEqual(templateRequiresEvaluation([{ str: 'foo: ' }, { dsl: '{foo}', json: { ref: 'foo' } }]), true)
    })
  })

  describe('compileSegments', function () {
    it('strings only: should return expected string', function () {
      assert.deepStrictEqual(compileSegments([{ str: 'foo' }]), '["foo"]')
      assert.deepStrictEqual(compileSegments([{ str: 'foo' }, { str: 'bar' }]), '["foo","bar"]')
    })

    it('dsl only: should return expected string if dsl compiles to simple evaluation', function () {
      assert.deepStrictEqual(compileSegments([{ dsl: 'foo', json: { ref: 'foo' } }]),
        `[(() => {
          try {
            const result = foo
            return typeof result === 'string' ? result : $dd_inspect(result, $dd_segmentInspectOptions)
          } catch (e) {
            return { expr: "foo", message: \`\${e.name}: \${e.message}\` }
          }
        })()]`
      )
    })

    it('dsl only: should return expected string if dsl compiles to function', function () {
      const result = compileSegments([{ dsl: 'foo.bar', json: { getmember: [{ ref: 'foo' }, 'bar'] } }])
      const prefix = '[(() => {\n          try {\n            const result = '
      assert.strictEqual(result.slice(0, prefix.length), prefix)
      assert.match(result.slice(prefix.length), /^\(\([^)]+\) => \{/)
    })

    it('mixed: should return expected string', function () {
      assert.deepStrictEqual(compileSegments([{ str: 'foo: ' }, { dsl: 'foo', json: { ref: 'foo' } }]),
        `["foo: ",(() => {
          try {
            const result = foo
            return typeof result === 'string' ? result : $dd_inspect(result, $dd_segmentInspectOptions)
          } catch (e) {
            return { expr: "foo", message: \`\${e.name}: \${e.message}\` }
          }
        })()]`
      )
    })
  })
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
      '--------------------------------------------------------------------------------',
    ].join('\n'))
    throw e
  }
}
