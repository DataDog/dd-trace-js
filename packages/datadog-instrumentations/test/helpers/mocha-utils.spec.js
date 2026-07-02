'use strict'

const assert = require('node:assert/strict')

const { finishDeferredHookEnd } = require('../../src/mocha/utils')

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
})
