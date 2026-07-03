'use strict'

const assert = require('node:assert/strict')

const {
  finishDeferredHookEnd,
  wrapFailedTestReplayAfterEachHook,
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

  describe('wrapFailedTestReplayAfterEachHook', () => {
    it('keeps callback-style hooks callback-based while waiting for DI setup', async () => {
      let resolveSetProbe
      const setProbePromise = new Promise(resolve => {
        resolveSetProbe = resolve
      })
      let hookDone
      let doneCount = 0
      function hook (done) {
        hookDone = done
        done()
      }
      function done () {
        doneCount++
      }
      const wrapped = wrapFailedTestReplayAfterEachHook(hook, {}, setProbePromise)

      assert.strictEqual(wrapped.length, 1)
      assert.strictEqual(wrapped(done), undefined)
      assert.strictEqual(doneCount, 0)

      resolveSetProbe()
      await setProbePromise
      await Promise.resolve()

      assert.strictEqual(hookDone, done)
      assert.strictEqual(doneCount, 1)
    })

    it('runs deferred hook-end finish before non-callback hooks', async () => {
      const calls = []
      const test = {
        _ddDeferredHookEnd: {
          waitForHitProbePromise: Promise.resolve(),
          publishTestFinish () {
            calls.push('finish')
          },
        },
      }
      function hook () {
        calls.push('hook')
      }

      const wrapped = wrapFailedTestReplayAfterEachHook(hook, test)

      assert.strictEqual(wrapped.length, 0)
      await wrapped()

      assert.deepStrictEqual(calls, ['finish', 'hook'])
    })
  })
})
