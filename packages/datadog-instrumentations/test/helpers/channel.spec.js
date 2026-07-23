'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { describe, it } = require('mocha')

const Plugin = require('../../../dd-trace/src/plugins/plugin')
const {
  getChannelPromise,
  getRunStoresPromise,
  publishWithCompletion,
} = require('../../src/helpers/channel')

describe('packages/datadog-instrumentations/src/helpers/channel.js', () => {
  it('completes without a subscriber', async () => {
    const finishCh = channel('ci:channel:test:no-subscriber')

    assert.strictEqual(await getChannelPromise(finishCh), undefined)
  })

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

  it('completes when a failing plugin handler disables its subscriber', async () => {
    const channelName = 'ci:channel:test:plugin-failure'
    const finishCh = channel(channelName)
    const plugin = new Plugin()
    plugin.addSub(channelName, () => {
      throw new Error('plugin failure')
    })
    plugin.configure(true)

    try {
      assert.strictEqual(await getChannelPromise(finishCh), undefined)
      assert.strictEqual(finishCh.hasSubscribers, false)
    } finally {
      plugin.configure(false)
    }
  })

  it('completes runStores when a failing plugin handler disables its subscriber', async () => {
    const channelName = 'ci:channel:test:run-stores-plugin-failure'
    const finishCh = channel(channelName)
    const plugin = new Plugin()
    plugin.addSub(channelName, () => {
      throw new Error('plugin failure')
    })
    plugin.configure(true)

    try {
      assert.strictEqual(await getRunStoresPromise(finishCh), undefined)
      assert.strictEqual(finishCh.hasSubscribers, false)
    } finally {
      plugin.configure(false)
    }
  })

  it('completes once when a removed subscriber invokes its callback later', () => {
    const finishCh = channel('ci:channel:test:complete-once')
    let onDone
    let completionCount = 0
    const onFinish = ({ onDone: finish }) => {
      onDone = finish
      finishCh.unsubscribe(onFinish)
    }

    finishCh.subscribe(onFinish)

    try {
      publishWithCompletion(finishCh, {}, () => {
        completionCount++
      })

      assert.strictEqual(completionCount, 1)
      onDone()
      assert.strictEqual(completionCount, 1)
    } finally {
      finishCh.unsubscribe(onFinish)
    }
  })
})
