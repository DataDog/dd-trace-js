'use strict'

const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const { channel } = require('dc-polyfill')
const { describe, it } = require('mocha')

const { getChannelPromise } = require('../src/vitest-util')

describe('packages/datadog-instrumentations/src/vitest-util.js', () => {
  it('waits while a subscriber owns completion', async () => {
    const finishCh = channel('ci:vitest-util:test:finish')
    let onDone
    const onFinish = ({ onDone: finish }) => {
      onDone = finish
    }

    finishCh.subscribe(onFinish)

    try {
      const finishPromise = getChannelPromise(finishCh, '3.2.0', { status: 'pass' })
      let hasCompleted = false
      const completedPromise = (async () => {
        await finishPromise
        hasCompleted = true
      })()

      await Promise.resolve()

      assert.strictEqual(hasCompleted, false)
      onDone()
      assert.strictEqual(await finishPromise, undefined)
      await completedPromise
    } finally {
      finishCh.unsubscribe(onFinish)
    }
  })

  it('completes when the subscriber disables itself during publication', async () => {
    const finishCh = channel('ci:vitest-util:test:finish')
    const onFinish = () => {
      finishCh.unsubscribe(onFinish)
    }

    finishCh.subscribe(onFinish)

    try {
      let hasCompleted = false
      const completedPromise = (async () => {
        await getChannelPromise(finishCh, '3.2.0', { status: 'pass' })
        hasCompleted = true
      })()

      await setImmediate()

      assert.strictEqual(hasCompleted, true)
      await completedPromise
    } finally {
      finishCh.unsubscribe(onFinish)
    }
  })
})
