'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const RedisPlugin = require('../src')
const { formatCommand } = RedisPlugin

describe('redis formatCommand', () => {
  it('returns the verb when args is undefined', () => {
    assert.strictEqual(formatCommand('GET'), 'GET')
  })

  it('returns the verb only for AUTH (never logs the password)', () => {
    assert.strictEqual(formatCommand('AUTH', ['supersecret']), 'AUTH')
  })

  it('formats short string args without trimming', () => {
    assert.strictEqual(formatCommand('GET', ['foo']), 'GET foo')
    assert.strictEqual(formatCommand('SET', ['foo', 'bar']), 'SET foo bar')
  })

  it('formats numeric args', () => {
    assert.strictEqual(formatCommand('EXPIRE', ['key', 60]), 'EXPIRE key 60')
  })

  it('skips function args (callbacks)', () => {
    const cb = () => {}
    assert.strictEqual(formatCommand('GET', ['foo', cb]), 'GET foo')
  })

  it('replaces non-string non-number args with `?`', () => {
    assert.strictEqual(formatCommand('SET', ['foo', { complex: 'object' }]), 'SET foo ?')
    assert.strictEqual(formatCommand('SET', ['foo', Buffer.from('bytes')]), 'SET foo ?')
  })

  it('trims a single string arg longer than 100 chars to 97 + "..."', () => {
    const arg = 'x'.repeat(150)
    const result = formatCommand('SET', ['key', arg])
    assert.strictEqual(result, `SET key ${'x'.repeat(97)}...`)
    assert.strictEqual(result.length, 'SET key '.length + 100)
  })

  it('handles a 100KB string arg without materialising the full input', () => {
    // Regression for the per-arg fast path in `formatArg`: a primitive string
    // longer than 100 chars must hit the slice fast path and never reach
    // `String(arg)` (which would prevent V8 from skipping cons-string flattening
    // when the caller does not need the full string).
    const huge = 'x'.repeat(100_000)
    const result = formatCommand('SET', ['key', huge])
    assert.strictEqual(result.length, 'SET key '.length + 100)
    assert.strictEqual(result.startsWith('SET key xxx'), true)
    assert.strictEqual(result.endsWith('...'), true)
  })

  it('caps the joined output at 1000 chars across many args', () => {
    const args = Array.from({ length: 1000 }, (_, index) => `arg${index}`)
    const result = formatCommand('MSET', args)
    assert.strictEqual(result.length, 1000)
    assert.strictEqual(result.endsWith('...'), true)
  })

  it('produces the same result with argsStartIndex=1 as with the sliced array', () => {
    // Regression for #5: dropping `args.slice(1)` in v4 redis instrumentation.
    const command = ['GET', 'foo']
    const sliced = formatCommand(command[0], command.slice(1))
    const startIndex = formatCommand(command[0], command, 1)
    assert.strictEqual(startIndex, sliced)
  })

  it('respects argsStartIndex with multiple args', () => {
    const command = ['SET', 'foo', 'bar', 'baz']
    assert.strictEqual(
      formatCommand(command[0], command, 1),
      formatCommand(command[0], command.slice(1))
    )
  })

  it('respects argsStartIndex when arg trimming kicks in', () => {
    const huge = 'z'.repeat(100_000)
    const command = ['SET', 'key', huge]
    assert.strictEqual(
      formatCommand(command[0], command, 1),
      formatCommand(command[0], command.slice(1))
    )
  })
})
