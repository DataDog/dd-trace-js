'use strict'

const assert = require('node:assert/strict')

const { MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION: MAX_LENGTH } =
  require('../../../dd-trace/src/encode/tags-processors')
const { getSessionError } = require('../../src/jest/session-error')

describe('Jest session errors', () => {
  const original = {
    name: 'TypeError',
    message: 'Setup failed',
    stack: 'TypeError: Setup failed\n    at setup (setup.js:1:1)',
  }

  function results (errors) {
    return {
      numFailedTestSuites: errors.length,
      numFailedTests: 0,
      testResults: errors.map(testExecError => ({ testExecError })),
    }
  }

  it('preserves a single setup error type and stack alongside the failure counts', () => {
    const input = results([Object.freeze({ ...original })])
    const error = getSessionError(input, false)
    assert.strictEqual(error.name, 'TypeError')
    assert.strictEqual(error.message, 'Failed test suites: 1. Failed tests: 0\n\nTypeError: Setup failed (1 suite)')
    assert.strictEqual(error.stack, original.stack)
    assert.deepStrictEqual(input, results([original]))
  })

  it('reports one shared error for a large number of suites', () => {
    const error = getSessionError(results(Array.from({ length: 100 }, () => ({ ...original }))), false)
    assert.match(error.message, /Failed test suites: 100/)
    assert.match(error.message, /TypeError: Setup failed \(100 suites\)/)
    assert.strictEqual(error.message.split('Setup failed').length - 1, 1)
    assert.strictEqual(error.stack, original.stack)
  })

  it('keeps distinct error types, messages and stacks in a stable order', () => {
    const errors = [original,
      { ...original, name: 'RangeError' },
      { ...original, message: 'Another setup failed' },
      { ...original, stack: 'TypeError: Setup failed\n    at other (other.js:2:1)' },
    ]
    const error = getSessionError(results(errors), false)
    const reversed = getSessionError(results([...errors].reverse()), false)
    assert.strictEqual(error.name, 'Error')
    assert.strictEqual(error.message, reversed.message)
    assert.strictEqual(error.stack, reversed.stack)
    assert.strictEqual(error.message.split('(1 suite)').length - 1, 4)
    assert.match(error.stack, /other\.js/)
  })

  it('keeps the generic summary when tests executed or no suite errors are available', () => {
    for (const [input, executed] of [[results([original]), true], [results([undefined, {}]), false]]) {
      const error = getSessionError(input, executed)
      assert.strictEqual(error.name, 'Error')
      assert.strictEqual(error.message, `Failed test suites: ${input.numFailedTestSuites}. Failed tests: 0`)
      assert.doesNotMatch(error.message, /Setup failed/)
    }
  })

  it('handles serialized errors, missing stacks, and ANSI formatting', () => {
    const input = results([{ type: 'SyntaxError', message: '\u001b[31mInvalid setup\u001b[0m' }])
    const error = getSessionError(input, false)
    assert.strictEqual(error.name, 'SyntaxError')
    assert.match(error.message, /SyntaxError: Invalid setup/)
    assert.strictEqual(error.stack, 'SyntaxError: Invalid setup')
  })

  for (const field of ['name', 'type', 'message', 'stack']) {
    it(`ignores non-string ${field} values without invoking custom coercion`, () => {
      const invalidValues = [undefined, null, 42, true, Symbol('invalid'), [], {
        toString () { assert.fail('Error fields must not invoke user-defined coercion') },
      }]
      for (const value of invalidValues) {
        const input = { ...original, [field]: value }
        if (field === 'type') delete input.name
        const error = getSessionError(results([input]), false)
        const name = field === 'name' || field === 'type' ? 'Error' : original.name
        const message = field === 'message' ? '' : original.message
        assert.strictEqual(error.name, name)
        assert.strictEqual(error.message, `Failed test suites: 1. Failed tests: 0\n\n${name}: ${message} (1 suite)`)
        assert.strictEqual(error.stack, field === 'stack' ? `${name}: ${message}` : original.stack)
      }
    })

    it(`skips errors with throwing ${field} accessors while preserving other suite errors`, () => {
      const input = { ...original }
      if (field === 'type') delete input.name
      Object.defineProperty(input, field, {
        get () { throw new Error('Cannot read setup error field') },
      })

      const fallback = getSessionError(results([input]))
      assert.strictEqual(fallback.name, 'Error')
      assert.strictEqual(fallback.message, 'Failed test suites: 1. Failed tests: 0')

      const mixed = getSessionError(results([original, input, original]))
      assert.strictEqual(mixed.name, original.name)
      assert.strictEqual(mixed.message, 'Failed test suites: 3. Failed tests: 0\n\nTypeError: Setup failed (2 suites)')
      assert.strictEqual(mixed.stack, original.stack)
    })
  }

  it('keeps the summary for revoked error proxies', () => {
    const { proxy, revoke } = Proxy.revocable(original, {})
    revoke()
    const error = getSessionError(results([proxy]))
    assert.strictEqual(error.name, 'Error')
    assert.strictEqual(error.message, 'Failed test suites: 1. Failed tests: 0')
  })

  it('uses a valid serialized type when the name is malformed', () => {
    const error = getSessionError(results([{ ...original, name: 42, type: '\u001b[31mSyntaxError\u001b[0m' }]))
    assert.strictEqual(error.name, 'SyntaxError')
    assert.match(error.message, /SyntaxError: Setup failed/)
  })

  it('keeps the summary when all error fields are malformed', () => {
    const error = getSessionError(results([{ name: {}, type: true, message: 42, stack: [] }]))
    assert.strictEqual(error.name, 'Error')
    assert.strictEqual(error.message, 'Failed test suites: 1. Failed tests: 0')
  })

  for (const field of ['name', 'type']) {
    it(`preserves ${field} at the limit and bounds it at the first rejected size`, () => {
      const input = { message: 'Setup failed', stack: original.stack, [field]: 'x'.repeat(MAX_LENGTH) }
      assert.strictEqual(getSessionError(results([input])).name, input[field])
      input[field] += 'x'
      const error = getSessionError(results([input]))
      assert.strictEqual(error.name, `${'x'.repeat(MAX_LENGTH - 3)}...`)
      assert.strictEqual(error.stack, original.stack)
    })
  }

  it('does not split surrogate pairs when truncating an error type', () => {
    const error = getSessionError(results([{ ...original, name: '😀'.repeat(MAX_LENGTH) }]))
    assert.strictEqual(error.name, `${'😀'.repeat(Math.floor((MAX_LENGTH - 3) / 2))}...`)
    assert.ok(error.name.length <= MAX_LENGTH)
  })

  for (const field of ['message', 'stack']) {
    it(`preserves ${field} at the limit and labels truncation at the first rejected size`, () => {
      const input = { name: 'Error', message: 'x', stack: 'x' }
      const prefixLength = field === 'message'
        ? 'Failed test suites: 1. Failed tests: 0\n\nError:  (1 suite)'.length
        : 0
      input[field] = 'x'.repeat(MAX_LENGTH - prefixLength)
      const accepted = getSessionError(results([input]), false)
      assert.strictEqual(accepted[field].length, MAX_LENGTH)
      assert.doesNotMatch(accepted[field], /truncated/)
      input[field] += 'x'
      const truncated = getSessionError(results([input]), false)
      assert.strictEqual(truncated[field].length, MAX_LENGTH)
      assert.match(truncated[field], /Error details truncated/)
      assert.match(truncated[field], /See suite events for full details\.\]$/)
    })
  }

  it('counts omitted distinct errors and bounds both fields for many large errors', () => {
    const errors = Array.from({ length: 100 }, (_, index) => ({
      name: 'Error', message: `${index}: ${'x'.repeat(MAX_LENGTH)}`, stack: `${index}: ${'y'.repeat(MAX_LENGTH)}`,
    }))
    const error = getSessionError(results(errors), false)
    for (const value of [error.message, error.stack]) {
      assert.strictEqual(value.length, MAX_LENGTH)
      assert.match(value, /99 additional distinct errors omitted/)
    }
  })

  it('does not split surrogate pairs when truncating a stack', () => {
    const error = getSessionError(results([{ ...original, stack: '😀'.repeat(MAX_LENGTH) }]), false)
    assert.ok(error.stack.length <= MAX_LENGTH)
    assert.doesNotMatch(error.stack, /[\uD800-\uDBFF]\n/)
  })

  it('reserves the separator when another error follows a nearly full field', () => {
    const notice = '\n\n[Error details truncated. 2 additional distinct errors omitted. ' +
      'See suite events for full details.]'
    const error = getSessionError(results([
      { name: 'Error', message: 'a', stack: 'a'.repeat(MAX_LENGTH - notice.length - 'Affected suites: 1\n'.length) },
      { name: 'Error', message: 'b', stack: 'b'.repeat(MAX_LENGTH) },
      { name: 'Error', message: 'c', stack: 'c' },
    ]), false)
    assert.ok(error.stack.length <= MAX_LENGTH)
    assert.strictEqual(error.stack.slice(-notice.length), notice)
  })

  it('handles bail results without test counts or suite results', () => {
    assert.strictEqual(getSessionError().message, 'Failed test suites: 0. Failed tests: 0')
    const input = results([original])
    assert.match(getSessionError(input).message, /Setup failed/)
    assert.strictEqual(getSessionError({ ...input, numPassedTests: 1 }).message,
      'Failed test suites: 1. Failed tests: 0')
  })
})
