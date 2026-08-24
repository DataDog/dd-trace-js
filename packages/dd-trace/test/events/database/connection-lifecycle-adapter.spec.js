'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { storage } = require('../../../../datadog-core')
const { ConnectionLifecycleAdapter } = require('../../../src/events/database')

const legacyStorage = storage('legacy')

describe('ConnectionLifecycleAdapter', () => {
  it('captures connection and deferred-command caller stores', () => {
    const adapter = new ConnectionLifecycleAdapter()
    const connectionContext = {}
    const commandContext = {}
    const parentStore = { parent: true }

    legacyStorage.run(parentStore, () => {
      adapter.start(connectionContext)
      adapter.captureParent(commandContext)
    })

    assert.strictEqual(adapter.finish(connectionContext), parentStore)
    assert.strictEqual(commandContext.parentStore, parentStore)
  })

  it('returns an isolated no-op store for driver-owned connection work', () => {
    const adapter = new ConnectionLifecycleAdapter()

    assert.deepStrictEqual(adapter.skip(), { noop: true })
  })
})
