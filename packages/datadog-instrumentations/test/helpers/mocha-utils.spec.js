'use strict'

const assert = require('node:assert/strict')

const {
  finishDeferredHookEnd,
  wrapFailedTestReplayHookUpCallback,
} = require('../../src/mocha/utils')

describe('mocha utils', () => {
  describe('finishDeferredHookEnd', () => {
    it('finishes synchronously when there is no DI wait promise', () => {
      let finishCount = 0
      let onFinishCount = 0
      const test = {
        _ddDeferredHookEnd: {
          publishTestFinish () {
            finishCount++
          },
          onFinish () {
            onFinishCount++
          },
        },
      }

      finishDeferredHookEnd(test)

      assert.strictEqual(finishCount, 1)
      assert.strictEqual(onFinishCount, 1)
      assert.strictEqual(test._ddDeferredHookEnd, undefined)
    })
  })

  describe('wrapFailedTestReplayHookUpCallback', () => {
    it('waits for DI setup before continuing afterEach hookUp', async () => {
      let resolveSetProbe
      const setProbePromise = new Promise(resolve => {
        resolveSetProbe = resolve
      })
      const err = new Error('test')
      const suite = {}
      let receivedArgs
      function next (err, suite) {
        receivedArgs = [err, suite]
      }
      const wrapped = wrapFailedTestReplayHookUpCallback(next, {}, setProbePromise)

      assert.strictEqual(wrapped.name, 'next')
      assert.strictEqual(wrapped.length, 2)
      wrapped(err, suite)

      assert.strictEqual(receivedArgs, undefined)

      resolveSetProbe()
      await setProbePromise
      await Promise.resolve()

      assert.deepStrictEqual(receivedArgs, [err, suite])
    })

    it('runs deferred hook-end finish before continuing afterEach hookUp', async () => {
      const calls = []
      const test = {
        _ddDeferredHookEnd: {
          waitForHitProbePromise: Promise.resolve(),
          publishTestFinish () {
            calls.push('finish')
          },
        },
      }
      function next () {
        calls.push('next')
      }

      const wrapped = wrapFailedTestReplayHookUpCallback(next, test)

      assert.strictEqual(wrapped.length, 0)
      await wrapped()

      assert.deepStrictEqual(calls, ['finish', 'next'])
    })
  })
})
