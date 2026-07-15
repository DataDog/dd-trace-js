'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { describe, it } = require('mocha')

const {
  getChannelPromise,
  publishWithCompletion,
} = require('../../src/helpers/channel')

describe('packages/datadog-instrumentations/src/helpers/channel.js', () => {
  it('waits while a subscriber owns completion', async () => {
    const finishCh = channel('ci:channel:test:wait')
    let onDone
    const onFinish = ({ onDone: finish, status }) => {
      assert.strictEqual(status, 'pass')
      onDone = finish
    }

    finishCh.subscribe(onFinish)

    try {
      const finishPromise = getChannelPromise(finishCh, { status: 'pass' })
      let hasCompleted = false
      const completedPromise = (async () => {
        await finishPromise
        hasCompleted = true
      })()

      await Promise.resolve()

      assert.strictEqual(hasCompleted, false)
      onDone('flushed')
      assert.strictEqual(await finishPromise, 'flushed')
      await completedPromise
    } finally {
      finishCh.unsubscribe(onFinish)
    }
  })

  it('completes when publication removes the last subscriber', async () => {
    const finishCh = channel('ci:channel:test:subscriber-loss')
    const onFinish = () => {
      finishCh.unsubscribe(onFinish)
    }

    finishCh.subscribe(onFinish)

    try {
      assert.strictEqual(await getChannelPromise(finishCh), undefined)
    } finally {
      finishCh.unsubscribe(onFinish)
    }
  })

  it('completes once when the subscriber finishes and removes itself', () => {
    const finishCh = channel('ci:channel:test:complete-once')
    let completionCount = 0
    const onFinish = ({ onDone }) => {
      onDone()
      finishCh.unsubscribe(onFinish)
    }

    finishCh.subscribe(onFinish)

    try {
      publishWithCompletion(finishCh, {}, () => {
        completionCount++
      })

      assert.strictEqual(completionCount, 1)
    } finally {
      finishCh.unsubscribe(onFinish)
    }
  })
})
