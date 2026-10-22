'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../setup/core')

const { enable, PRODUCT } = require('../../src/profiling/remote-config')

describe('Profiling Remote Config', () => {
  let rc
  let config
  let handler

  beforeEach(() => {
    handler = undefined
    rc = {
      subscribeProducts: sinon.spy(),
      setBatchHandler: sinon.spy((products, batchHandler) => {
        handler = batchHandler
      }),
    }
    config = {
      service: 'my-service',
      env: 'prod',
      tags: { team: 'profiling', region: 'eu' },
      setRemoteConfig: sinon.spy(),
    }
    enable(rc, config)
  })

  /**
   * @param {{ toApply?: object[], toModify?: object[], toUnapply?: object[] }} items
   */
  function update ({ toApply = [], toModify = [], toUnapply = [] }) {
    const addDefaults = (item) => ({ product: PRODUCT, path: `datadog/2/${PRODUCT}/${item.id}/config`, ...item })
    const transaction = {
      toApply: toApply.map(addDefaults),
      toModify: toModify.map(addDefaults),
      toUnapply: toUnapply.map(addDefaults),
      ack: sinon.spy(),
      error: sinon.spy(),
    }
    handler(transaction)
    return transaction
  }

  // Current layer settings, or null before the first write.
  function currentSettings () {
    const { lastCall } = config.setRemoteConfig
    if (lastCall === null) return null
    assert.strictEqual(lastCall.args[1], 'profiling')
    return lastCall.args[0]
  }

  it('subscribes to the product with a batch handler', () => {
    assert.strictEqual(PRODUCT, 'DEBUG')
    sinon.assert.calledOnceWithExactly(rc.subscribeProducts, 'DEBUG')
    sinon.assert.calledOnceWithExactly(rc.setBatchHandler, ['DEBUG'], sinon.match.func)
  })

  describe('updates', () => {
    it('does not touch the profiling layer for payloads of other DEBUG users', () => {
      update({ toApply: [{ id: 'other-team', file: { something: 'else' } }] })
      update({ toModify: [{ id: 'other-team', file: { something: 'different' } }] })
      update({ toUnapply: [{ id: 'other-team' }] })

      sinon.assert.notCalled(config.setRemoteConfig)
    })

    it('does not touch the profiling layer when the merged settings are unchanged', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { memory: true } } }] })
      sinon.assert.calledOnce(config.setRemoteConfig)

      update({ toApply: [{ id: 'other-team', file: { something: 'else' } }] })
      update({ toModify: [{ id: 'a', file: { profilers: { memory: true }, targets: [{ env: 'prod' }] } }] })
      update({ toApply: [{ id: 'b', file: { profilers: { memory: true } } }] })

      sinon.assert.calledOnce(config.setRemoteConfig)
    })

    it('writes the profiling layer again once the merged settings change', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { memory: true } } }] })
      update({ toModify: [{ id: 'a', file: { profilers: { memory: false } } }] })
      update({ toUnapply: [{ id: 'a' }] })

      sinon.assert.calledThrice(config.setRemoteConfig)
      assert.deepStrictEqual(
        config.setRemoteConfig.secondCall.args,
        [{ DD_PROFILING_HEAP_ENABLED: 'false' }, 'profiling']
      )
      assert.deepStrictEqual(config.setRemoteConfig.thirdCall.args, [null, 'profiling'])
    })
  })

  describe('mapping', () => {
    it('maps each requested profile type and enables profiling', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: true, wallTime: true, memory: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'true',
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('runs the wall profiler for CPU time even when wall time is turned off', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: true, wallTime: false } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('turns off CPU time without touching the wall profiler', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: false } } }] })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_CPU_ENABLED: 'false' })
    })

    it('leaves the enablement to local config when only some types are turned off', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { wallTime: false, memory: false } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'false',
      })
    })

    it('disables profiling when every profile type is turned off', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: false, wallTime: false, memory: false } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'false',
      })
    })

    it('maps the upload interval without changing the enablement', () => {
      update({ toApply: [{ id: 'a', file: { settings: { uploadIntervalSeconds: 30 } } }] })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_UPLOAD_PERIOD: '30' })
    })

    it('reverts to local config for an empty profilers section', () => {
      update({ toApply: [{ id: 'a', file: { profilers: {} } }] })

      assert.strictEqual(currentSettings(), null)
    })
  })

  describe('validation', () => {
    it('ignores payloads without a profilers or settings section', () => {
      const transaction = update({ toApply: [{ id: 'other-team', file: { something: 'else' } }] })

      assert.strictEqual(currentSettings(), null)
      sinon.assert.calledOnceWithExactly(transaction.ack, `datadog/2/${PRODUCT}/other-team/config`)
    })

    it('ignores payloads that are not objects', () => {
      update({ toApply: [{ id: 'a', file: null }, { id: 'b', file: 'profilers' }] })

      assert.strictEqual(currentSettings(), null)
    })

    it('ignores fields of the wrong type and keeps the valid ones', () => {
      update({
        toApply: [{
          id: 'a',
          file: {
            profilers: { cpuTime: 'true', wallTime: 1, memory: true, unknown: true },
            settings: { uploadIntervalSeconds: '30' },
          },
        }],
      })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
    })

    it('accepts the smallest valid upload interval and rejects zero, negative and fractional ones', () => {
      update({ toApply: [{ id: 'a', file: { settings: { uploadIntervalSeconds: 1 } } }] })
      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_UPLOAD_PERIOD: '1' })

      for (const uploadIntervalSeconds of [0, -1, 1.5]) {
        update({ toModify: [{ id: 'a', file: { settings: { uploadIntervalSeconds } } }] })
        assert.strictEqual(currentSettings(), null)
      }
    })

    it('ignores a config whose targets are not an array', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { memory: true }, targets: { service: 'my-service' } } }] })

      assert.strictEqual(currentSettings(), null)
    })

    it('ignores a config whose targets are all invalid instead of applying it everywhere', () => {
      update({
        toApply: [{
          id: 'a',
          file: { profilers: { memory: true }, targets: [{ service: 1 }, { tags: 'team:profiling' }, 'x'] },
        }],
      })

      assert.strictEqual(currentSettings(), null)
    })

    it('skips invalid targets and keeps the valid ones', () => {
      update({
        toApply: [{
          id: 'a',
          file: { profilers: { memory: true }, targets: [{ service: 1 }, { service: 'my-service' }] },
        }],
      })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
    })
  })

  describe('targets', () => {
    /**
     * @param {object} target
     */
    function applyTargeted (target) {
      update({ toApply: [{ id: 'a', file: { profilers: { memory: true }, targets: [target] } }] })
      return currentSettings()
    }

    it('applies configs whose target matches the service, env and tags', () => {
      assert.notStrictEqual(applyTargeted({}), null)
      assert.notStrictEqual(applyTargeted({ service: 'my-service', env: 'prod' }), null)
      assert.notStrictEqual(applyTargeted({ service: '*', env: '*' }), null)
      assert.notStrictEqual(applyTargeted({ tags: ['team:profiling', 'region:eu'] }), null)
    })

    it('ignores configs whose target does not match', () => {
      assert.strictEqual(applyTargeted({ service: 'other-service' }), null)
      assert.strictEqual(applyTargeted({ service: 'my-service', env: 'staging' }), null)
      assert.strictEqual(applyTargeted({ tags: ['team:profiling', 'region:us'] }), null)
      assert.strictEqual(applyTargeted({ tags: ['team'] }), null)
    })

    it('applies a config when any of its targets matches', () => {
      update({
        toApply: [{
          id: 'a',
          file: { profilers: { memory: true }, targets: [{ service: 'other-service' }, { env: 'prod' }] },
        }],
      })

      assert.notStrictEqual(currentSettings(), null)
    })
  })

  describe('merging', () => {
    it('lets more specific configs win, field by field', () => {
      update({
        toApply: [
          {
            id: 'service-env',
            file: { profilers: { memory: false }, targets: [{ service: 'my-service', env: 'prod' }] },
          },
          { id: 'service', file: { profilers: { wallTime: false }, targets: [{ service: 'my-service' }] } },
          { id: 'env', file: { profilers: { wallTime: true, cpuTime: false }, targets: [{ env: 'prod' }] } },
          { id: 'tags', file: { settings: { uploadIntervalSeconds: 10 }, targets: [{ tags: ['team:profiling'] }] } },
          { id: 'org', file: { profilers: { memory: true }, settings: { uploadIntervalSeconds: 20 } } },
        ],
      })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'false',
        DD_PROFILING_UPLOAD_PERIOD: '10',
        DD_PROFILING_ENABLED: 'false',
      })
    })

    it('breaks ties between equally specific configs by id, independent of delivery order', () => {
      const first = { id: 'a', file: { profilers: { memory: true } } }
      const second = { id: 'b', file: { profilers: { memory: false } } }

      update({ toApply: [first, second] })
      const inOrder = currentSettings()
      update({ toUnapply: [first, second] })
      update({ toApply: [second, first] })

      assert.deepStrictEqual(currentSettings(), inOrder)
      assert.strictEqual(inOrder.DD_PROFILING_HEAP_ENABLED, 'false')
    })

    it('keeps configs across updates and drops them on unapply', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { memory: true } } }] })
      update({ toApply: [{ id: 'b', file: { settings: { uploadIntervalSeconds: 30 } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
        DD_PROFILING_UPLOAD_PERIOD: '30',
      })

      update({ toUnapply: [{ id: 'a' }] })
      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_UPLOAD_PERIOD: '30' })

      update({ toUnapply: [{ id: 'b' }] })
      assert.strictEqual(currentSettings(), null)
    })

    it('replaces a config on modify, and drops it when it no longer carries profiling content', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { memory: true } } }] })
      update({ toModify: [{ id: 'a', file: { profilers: { memory: false } } }] })
      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'false' })

      update({ toModify: [{ id: 'a', file: { unrelated: true } }] })
      assert.strictEqual(currentSettings(), null)
    })

    it('acknowledges every item', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { memory: true } } }] })
      const transaction = update({
        toApply: [{ id: 'b', file: { profilers: { memory: true } } }],
        toModify: [{ id: 'c', file: { nothing: 'here' } }],
        toUnapply: [{ id: 'a' }],
      })

      sinon.assert.calledThrice(transaction.ack)
      sinon.assert.notCalled(transaction.error)
    })
  })
})
