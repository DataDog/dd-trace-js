'use strict'

const assert = require('node:assert/strict')
const { join } = require('node:path')

const Mocha = require('mocha')

const { collectFailure, knownFailureHooks } = require('./known-failures')

describe('Bun known failures', () => {
  it('records the original assertion rather than a secondary multiple-done error', () => {
    const failures = {}
    const test = new Mocha.Test('case', () => {})
    new Mocha().suite.addTest(test)
    test.file = join(process.cwd(), 'case.spec.js')
    collectFailure(failures, test, new assert.AssertionError({ message: 'original' }))
    collectFailure(failures, test, new Error('done() called multiple times'))
    assert.deepStrictEqual(failures, { 'case.spec.js': { case: 'test assertion failed under Bun' } })
  })

  it('records stable timeout reasons without machine-specific paths', () => {
    const failures = {}
    const test = new Mocha.Test('case', () => {})
    new Mocha().suite.addTest(test)
    test.file = join(process.cwd(), 'case.spec.js')
    const error = new Error(`Timed out at ${test.file}`)
    error.code = 'ERR_MOCHA_TIMEOUT'
    collectFailure(failures, test, error)
    assert.deepStrictEqual(failures, { 'case.spec.js': { case: 'test timed out under Bun' } })
  })

  for (const [name, body] of [
    ['sync', () => { throw new Error('not instrumented') }],
    ['promise', async () => { throw new Error('not instrumented') }],
    ['callback', done => done(new Error('not instrumented'))],
  ]) {
    it(`reports a listed ${name} failure as pending with a reason`, async () => {
      const result = await runCase(body, true)
      assert.strictEqual(result.failures, 0)
      assert.strictEqual(result.stats.pending, 1)
      assert.match(result.test.title, /known Bun failure: missing hook/)
    })
  }

  it('fails when a listed test unexpectedly passes', async () => {
    const result = await runCase(() => {}, true)
    assert.strictEqual(result.failures, 1)
    assert.match(result.error.message, /unexpectedly passed\. Remove .*known-failures.json/)
  })

  it('preserves unlisted failures', async () => {
    const result = await runCase(() => { throw new Error('regression') })
    assert.strictEqual(result.failures, 1)
    assert.strictEqual(result.error.message, 'regression')
  })

  it('preserves unlisted passes with an empty list', async () => {
    const result = await runCase(() => {})
    assert.strictEqual(result.failures, 0)
    assert.strictEqual(result.stats.passes, 1)
  })

  it('does not invert explicit skips', async () => {
    const result = await runCase(function () { this.skip() }, true)
    assert.strictEqual(result.failures, 0)
    assert.strictEqual(result.stats.pending, 1)
    assert.strictEqual(result.test.title, 'case')
  })

  it('does not mask setup failures', async () => {
    const result = await runCase(() => {}, true, () => { throw new Error('setup broken') })
    assert.strictEqual(result.failures, 1)
    assert.strictEqual(result.stats.passes, 0)
  })

  it('does not mask teardown failures after an expected failure', async () => {
    const result = await runCase(() => { throw new Error('known') }, true, undefined,
      () => { throw new Error('cleanup broken') })
    assert.strictEqual(result.failures, 1)
    assert.strictEqual(result.stats.pending, 1)
  })

  it('matches both the spec file and full title', async () => {
    const result = await runCase(() => { throw new Error('regression') }, false, undefined, undefined, {
      'other.spec.js': { case: 'missing hook' },
      'integration-tests/bun/case.spec.js': { other: 'missing hook' },
    })
    assert.strictEqual(result.failures, 1)
  })
})

/**
 * @param {import('mocha').Func | import('mocha').AsyncFunc} body
 * @param {boolean} [listed]
 * @param {import('mocha').Func} [before]
 * @param {import('mocha').Func} [after]
 * @param {Record<string, Record<string, string>>} [failures]
 */
async function runCase (body, listed = false, before, after, failures = {}) {
  const file = 'integration-tests/bun/case.spec.js'
  if (listed) failures[file] = { case: 'missing hook' }
  const mocha = new Mocha({ reporter: function () {}, timeout: 0 })
  mocha.rootHooks(knownFailureHooks(failures))
  const test = new Mocha.Test('case', body)
  test.file = join(process.cwd(), file)
  mocha.suite.addTest(test)
  if (before) mocha.suite.beforeEach(before)
  if (after) mocha.suite.afterEach(after)
  let runner
  let error
  const count = await new Promise(resolve => {
    runner = mocha.run(resolve)
    runner.on('fail', (_, failure) => { error = failure })
  })
  const result = { failures: count, stats: runner.stats, test, error }
  mocha.dispose()
  return result
}
