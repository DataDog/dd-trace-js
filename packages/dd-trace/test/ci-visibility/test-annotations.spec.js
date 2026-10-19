'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const { preventFailureSuppression, noAutoRetry } = require('../../../../test-optimization')

// Exercise the public helpers without depending on their metadata representation.
describe('Test Optimization callback annotations', () => {
  it('documents Mocha annotation enforcement without a Jest-only disclaimer', () => {
    const api = readFileSync(resolve(__dirname, '../../../../docs/API.md'), 'utf8').replace(/\r\n/g, '\n')
    const exclusions = api.slice(api.indexOf('## Mocha test automation exclusions'))
    const [, mocha] = api.match(/## Mocha test automation exclusions\n([\s\S]*?)(?:\n## |$)/) || []
    assert.ok(mocha, 'Mocha exclusion helper support must be documented')
    assert.match(mocha, /preventFailureSuppression/)
    assert.match(mocha, /noAutoRetry/)
    assert.doesNotMatch(exclusions, /enforcement requires (?:only )?Jest instrumentation\b/)
    assert.doesNotMatch(exclusions, /Other test frameworks[^.]*do not enforce (?:these helpers|them)\b/)
  })

  for (const helper of [preventFailureSuppression, noAutoRetry, fn => preventFailureSuppression(noAutoRetry(fn))]) {
    it('preserves parameters, this, return values, and callback arity', () => {
      const callback = Object.freeze(function callback (a, b) { return this.offset + a + b })
      const annotated = helper(callback)
      assert.strictEqual(annotated.length, 2)
      assert.strictEqual(annotated.name, 'callback')
      assert.strictEqual(annotated.call({ offset: 1 }, 2, 3), 6)
      assert.notStrictEqual(annotated, callback)
      assert.strictEqual(Object.isFrozen(annotated), true)
      assert.strictEqual(Object.isFrozen(callback), true)
    })

    it('preserves callable own properties, accessors, and methods without evaluating getters', () => {
      const calls = []
      const marker = Symbol('callback marker')
      let reads = 0
      const callback = Object.freeze(Object.defineProperties(function callable (value) {
        calls.push(value)
      }, {
        _isMockFunction: { value: true },
        mock: { get () { reads++; return { calls } } },
        mockClear: { value: () => { calls.length = 0 } },
        [marker]: { value: 'custom metadata', enumerable: true },
      }))

      const annotated = helper(callback)
      assert.strictEqual(reads, 0)
      assert.strictEqual(annotated._isMockFunction, true)
      annotated(42)
      assert.deepStrictEqual(annotated.mock.calls, [42])
      annotated.mockClear()
      assert.deepStrictEqual(annotated.mock.calls, [])
      assert.strictEqual(annotated[marker], 'custom metadata')
      for (const key of ['_isMockFunction', 'mock', 'mockClear', marker]) {
        assert.deepStrictEqual(
          Object.getOwnPropertyDescriptor(annotated, key),
          Object.getOwnPropertyDescriptor(callback, key)
        )
      }
      assert.strictEqual(Object.isFrozen(callback), true)
    })

    it('preserves synchronous failures', () => {
      const error = new Error('original')
      assert.throws(helper(() => { throw error }), actual => actual === error)
    })

    it('preserves asynchronous results and failures', async () => {
      const promise = Promise.resolve(42)
      const returnsPromise = helper(() => promise)
      assert.strictEqual(returnsPromise(), promise)
      const error = new Error('original')
      const rejects = helper(async () => { throw error })
      await assert.rejects(rejects(), actual => actual === error)
    })

    it('preserves the callback source for framework fixture discovery', () => {
      function callback ({ value }) { return value }
      const annotated = helper(helper(callback))
      assert.strictEqual(annotated.toString(), callback.toString())
      assert.strictEqual(annotated.name, callback.name)
      assert.strictEqual(annotated.length, callback.length)
      assert.strictEqual(annotated({ value: 42 }), 42)
    })

    it('preserves done callbacks', done => {
      const annotated = helper(callback => callback())
      assert.strictEqual(annotated.length, 1)
      annotated(done)
    })
  }

  it('rejects non-functions at the public API boundary', () => {
    for (const helper of [preventFailureSuppression, noAutoRetry]) {
      for (const input of [undefined, null, {}, 'test']) {
        // @ts-expect-error Deliberately exercise invalid runtime input.
        assert.throws(() => helper(input), {
          name: 'TypeError', message: 'Test annotations require a test callback',
        })
      }
    }
  })
})
