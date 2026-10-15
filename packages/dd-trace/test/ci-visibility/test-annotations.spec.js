'use strict'

const assert = require('node:assert/strict')

const { preventFailureSuppression, noAutoRetry } = require('../../../../test-optimization')

// Exercise the public helpers without depending on their metadata representation.
describe('Test Optimization callback annotations', () => {
  for (const helper of [preventFailureSuppression, noAutoRetry, fn => preventFailureSuppression(noAutoRetry(fn))]) {
    it('preserves parameters, this, return values, and callback arity', () => {
      const callback = Object.freeze(function callback (a, b) { return this.offset + a + b })
      const annotated = helper(callback)
      assert.strictEqual(annotated.length, 2)
      assert.strictEqual(annotated.name, 'callback')
      assert.strictEqual(annotated.call({ offset: 1 }, 2, 3), 6)
      assert.notStrictEqual(annotated, callback)
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
