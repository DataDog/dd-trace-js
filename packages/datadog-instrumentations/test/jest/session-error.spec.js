'use strict'

const assert = require('node:assert/strict')

const { MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION: MAX_LENGTH } =
  require('../../../dd-trace/src/encode/tags-processors')
const { getSessionError } = require('../../src/jest/session-error')

describe('Jest session errors', () => {
  const original = Object.freeze({
    name: 'TypeError',
    message: 'Setup failed',
    stack: 'TypeError: Setup failed\n    at setup (setup.js:1:1)',
  })
  const omitted = '\n\nError details exceed the size limit. See test and suite events for full details.'

  function results (errors) {
    return {
      numFailedTestSuites: errors.length,
      numFailedTests: 0,
      testResults: errors.map(testExecError => ({ testExecError })),
    }
  }

  it('preserves complete setup details and deduplicates shared errors without mutating them', () => {
    for (const count of [1, 100]) {
      const error = getSessionError(results(Array.from({ length: count }, () => original)))
      assert.strictEqual(error.name, original.name)
      assert.strictEqual(error.stack, original.stack)
      const detail = `TypeError: Setup failed (${count} suite${count === 1 ? '' : 's'})`
      assert.strictEqual(error.message,
        `Failed test suites: ${count}. Failed tests: 0\n\n${detail}`)
    }
  })

  it('keeps distinct error types, messages and stacks in a stable order', () => {
    const errors = [original,
      { ...original, name: 'RangeError' },
      { ...original, message: 'Another setup failed' },
      { ...original, stack: 'TypeError: Setup failed\n    at other (other.js:2:1)' },
    ]
    const error = getSessionError(results(errors))
    const reversed = getSessionError(results([...errors].reverse()))
    assert.strictEqual(error.name, 'Error')
    assert.strictEqual(error.message, reversed.message)
    assert.strictEqual(error.stack, reversed.stack)
    assert.strictEqual(error.message.split('(1 suite)').length - 1, 4)
    assert.match(error.stack, /other\.js/)
  })

  it('keeps the generic summary when no error details are available', () => {
    for (const input of [
      undefined,
      results([undefined, {}]),
      { ...results([undefined]), numPassedTests: 1 },
      { ...results([undefined]), numFailedTests: 1 },
    ]) {
      const error = getSessionError(input)
      assert.strictEqual(error.name, 'Error')
      assert.strictEqual(error.message,
        `Failed test suites: ${input?.numFailedTestSuites || 0}. Failed tests: ${input?.numFailedTests || 0}`)
    }
  })

  it('includes setup errors alongside executed tests and Jest failure reports', () => {
    for (const testExecError of [undefined, { message: 'Teardown failed' }]) {
      const input = { ...results([original]), numPassedTests: 1, numFailedTests: 1, numFailedTestSuites: 2 }
      const failureMessage = '\u001b[31mAssertion failed\u001b[0m\n    at test (test.js:1:1)\nTeardown failed'
      input.testResults.push({ numFailingTests: 1, failureMessage, testExecError })
      const error = getSessionError(input)
      assert.strictEqual(error.name, 'Error')
      assert.strictEqual(error.message, 'Failed test suites: 2. Failed tests: 1\n\n' +
        'Error: Assertion failed\n    at test (test.js:1:1)\nTeardown failed (1 suite)\n\n' +
        'TypeError: Setup failed (1 suite)')
      assert.match(error.stack, /at test \(test.js:1:1\)/)
      assert.ok(error.stack.includes(original.stack))
    }
  })

  it('bounds and safely reads Jest failure reports', () => {
    for (const [entry, suffix] of [
      [{ failureMessage: { toString () { assert.fail('Must not coerce failure messages') } } }, ''],
      [{ get failureMessage () { throw new Error('Cannot read failure message') } }, ''],
      [{ failureMessage: 'x'.repeat(MAX_LENGTH + 1) }, omitted],
    ]) {
      const input = { ...results([undefined]), numFailedTests: 1, testResults: [entry] }
      const error = getSessionError(input)
      assert.strictEqual(error.message, `Failed test suites: 1. Failed tests: 1${suffix}`)
    }
  })

  it('handles serialized types, malformed names, missing stacks and ANSI formatting', () => {
    const input = { name: 42, type: 'SyntaxError', message: '\u001b[31mInvalid setup\u001b[0m' }
    const error = getSessionError(results([input]))
    assert.strictEqual(error.name, 'SyntaxError')
    assert.strictEqual(error.message, 'Failed test suites: 1. Failed tests: 0\n\nSyntaxError: Invalid setup (1 suite)')
    assert.strictEqual(error.stack, 'SyntaxError: Invalid setup')
  })

  it('ignores non-string fields without invoking custom coercion', () => {
    const invalid = { toString () { assert.fail('Error fields must not invoke user-defined coercion') } }
    const partial = getSessionError(results([{
      name: true, type: Symbol('invalid'), message: invalid, stack: original.stack,
    }]))
    assert.strictEqual(partial.name, 'Error')
    assert.strictEqual(partial.message, 'Failed test suites: 1. Failed tests: 0\n\nError:  (1 suite)')
    assert.strictEqual(partial.stack, original.stack)
    assert.strictEqual(getSessionError(results([{ ...original, stack: invalid }])).stack, 'TypeError: Setup failed')
    assert.strictEqual(getSessionError(results([{ message: invalid, stack: invalid }])).message,
      'Failed test suites: 1. Failed tests: 0')
  })

  it('skips unreadable errors while preserving valid errors from other suites', () => {
    for (const field of ['name', 'type', 'message', 'stack']) {
      const input = { ...original }
      if (field === 'type') delete input.name
      Object.defineProperty(input, field, { get () { throw new Error('Cannot read setup error field') } })
      assert.strictEqual(getSessionError(results([input])).message, 'Failed test suites: 1. Failed tests: 0')
      const mixed = getSessionError(results([original, input, original]))
      assert.strictEqual(mixed.name, original.name)
      assert.strictEqual(mixed.message, 'Failed test suites: 3. Failed tests: 0\n\nTypeError: Setup failed (2 suites)')
      assert.strictEqual(mixed.stack, original.stack)
    }
  })

  it('skips unreadable result entries while preserving valid errors from other suites', () => {
    const unreadable = { get testExecError () { throw new Error('Cannot read suite execution error') } }
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    for (const entry of [unreadable, proxy, undefined, null]) {
      const fallback = getSessionError({ ...results([undefined]), testResults: [entry] })
      assert.strictEqual(fallback.name, 'Error')
      assert.strictEqual(fallback.message, 'Failed test suites: 1. Failed tests: 0')

      const input = results([original, undefined, original])
      input.testResults[1] = entry
      const mixed = getSessionError(input)
      assert.strictEqual(mixed.name, original.name)
      assert.strictEqual(mixed.message, 'Failed test suites: 3. Failed tests: 0\n\nTypeError: Setup failed (2 suites)')
      assert.strictEqual(mixed.stack, original.stack)
    }
  })

  it('falls back to the generic summary when the results collection cannot be read or iterated', () => {
    const { proxy, revoke } = Proxy.revocable([], {})
    revoke()
    const interrupted = {
      * [Symbol.iterator] () {
        yield { testExecError: original }
        throw new Error('Cannot read the next suite result')
      },
    }
    for (const input of [
      { testResults: {} },
      { testResults: proxy },
      { testResults: interrupted },
      { get testResults () { throw new Error('Cannot read suite results') } },
    ]) {
      input.numFailedTestSuites = 2
      input.numFailedTests = 1
      const error = getSessionError(input)
      assert.strictEqual(error.name, 'Error')
      assert.strictEqual(error.message, 'Failed test suites: 2. Failed tests: 1')
      assert.doesNotMatch(error.stack, /Setup failed/)
    }
  })

  it('rejects oversized raw fields before ANSI removal and grouping', () => {
    for (const field of ['name', 'type', 'message', 'stack']) {
      const input = { ...original, [field]: `${'\u001b[31m'.repeat(MAX_LENGTH)}UNREAD TAIL` }
      if (field === 'type') delete input.name
      const error = getSessionError(results([input]))
      assert.strictEqual(error.name, 'Error')
      assert.strictEqual(error.message, `Failed test suites: 1. Failed tests: 0${omitted}`)
    }
  })

  for (const field of ['name', 'message', 'stack']) {
    it(`includes complete ${field} at the output limit and falls back at the first rejected size`, () => {
      const overhead = field === 'name'
        ? 'Failed test suites: 1. Failed tests: 0\n\n: Setup failed (1 suite)'.length
        : field === 'message' ? 'Failed test suites: 1. Failed tests: 0\n\nTypeError:  (1 suite)'.length : 0
      const input = { ...original, [field]: 'x'.repeat(MAX_LENGTH - overhead) }
      const accepted = getSessionError(results([input]))
      assert.strictEqual(accepted[field === 'stack' ? 'stack' : 'message'].length, MAX_LENGTH)
      assert.strictEqual(accepted.name, input.name)
      assert.strictEqual(accepted.stack, input.stack)
      input[field] += 'x'
      const rejected = getSessionError(results([input]))
      assert.strictEqual(rejected.name, 'Error')
      assert.strictEqual(rejected.message, `Failed test suites: 1. Failed tests: 0${omitted}`)
    })
  }

  it('falls back when individually valid errors exceed the combined output or grouping budget', () => {
    for (const count of [3, 100]) {
      const errors = Array.from({ length: count }, (_, index) => ({
        ...original, stack: `${index}: ${'x'.repeat(1800)}`,
      }))
      const error = getSessionError(results(errors))
      assert.strictEqual(error.name, 'Error')
      assert.strictEqual(error.message, `Failed test suites: ${count}. Failed tests: 0${omitted}`)
      assert.strictEqual(getSessionError(results([...errors].reverse())).message, error.message)
    }
  })
})
