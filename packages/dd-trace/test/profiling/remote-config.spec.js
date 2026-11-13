'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

/**
 * @param {{ allocationProfilingAvailable?: boolean, cpuProfilingAvailable?: boolean }} [capabilities]
 *   Runtime capabilities the module sees
 */
function loadRemoteConfig (capabilities) {
  return proxyquire('../../src/profiling/remote-config', {
    './runtime-capabilities': { allocationProfilingAvailable: false, cpuProfilingAvailable: true, ...capabilities },
  })
}

// Most tests run with CPU profiling but without allocation profiling, so that the set of mapped
// profile types doesn't depend on the runtime running them.
const { enable, PRODUCT } = loadRemoteConfig()

describe('Profiling Remote Config', () => {
  let rc
  let config
  let handler
  let getRunningProfileTypes

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
    // Unless a test says otherwise, every profile type already runs under local configuration, so
    // omitted fields keep their local values.
    getRunningProfileTypes = sinon.stub().returns(['wall', 'cpu', 'space', 'events'])
    // The fakes implement only what the handler uses.
    enable(
      /** @type {import('../../src/remote_config')} */ (/** @type {unknown} */ (rc)),
      /** @type {ReturnType<import('../../src/config')>} */ (/** @type {unknown} */ (config)),
      getRunningProfileTypes
    )
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
    assert.strictEqual(lastCall.args.length, 1)
    return lastCall.args[0]
  }

  it('subscribes to the product with a batch handler', () => {
    assert.strictEqual(PRODUCT, 'APM_PROFILING')
    sinon.assert.calledOnceWithExactly(rc.subscribeProducts, 'APM_PROFILING')
    sinon.assert.calledOnceWithExactly(rc.setBatchHandler, ['APM_PROFILING'], sinon.match.func)
  })

  it('does not subscribe in agentless mode', () => {
    const agentlessRc = { subscribeProducts: sinon.spy(), setBatchHandler: sinon.spy() }
    enable(
      /** @type {import('../../src/remote_config')} */ (/** @type {unknown} */ (agentlessRc)),
      /** @type {ReturnType<import('../../src/config')>} */ (/** @type {unknown} */ (
        { ...config, DD_AGENTLESS_ENABLED: true }
      )),
      getRunningProfileTypes
    )

    sinon.assert.notCalled(agentlessRc.subscribeProducts)
    sinon.assert.notCalled(agentlessRc.setBatchHandler)
  })

  describe('profile types that are not running locally', () => {
    it('turns off omitted profile types when turning profiling on from a stopped profiler', () => {
      getRunningProfileTypes.returns([])

      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('keeps omitted profile types that run locally and turns off the ones that do not', () => {
      getRunningProfileTypes.returns(['space'])

      update({ toApply: [{ id: 'a', file: { profilers: { wallTime: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('still runs the wall profiler for requested CPU time', () => {
      getRunningProfileTypes.returns([])

      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'true',
        DD_PROFILING_HEAP_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('does not turn off omitted profile types when the payload does not turn profiling on', () => {
      getRunningProfileTypes.returns(['space'])

      update({ toApply: [{ id: 'a', file: { profilers: { wallTime: false } } }] })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_WALLTIME_ENABLED: 'false' })
    })

    it('ignores running profiler types that serve no mapped profile type', () => {
      getRunningProfileTypes.returns(['events'])

      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })

      assert.strictEqual(currentSettings().DD_PROFILING_WALLTIME_ENABLED, 'false')
    })

    it('captures the local profile types once, at the first profiling content', () => {
      getRunningProfileTypes.returns([])

      update({ toApply: [{ id: 'unrelated', file: { something: 'else' } }] })
      sinon.assert.notCalled(getRunningProfileTypes)

      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })
      sinon.assert.calledOnce(getRunningProfileTypes)

      // The profiler now runs what remote config asked for; that must not count as local state.
      getRunningProfileTypes.returns(['space', 'wall', 'cpu'])
      update({ toModify: [{ id: 'a', file: { profilers: { heapSize: true, wallTime: true } } }] })

      sinon.assert.calledOnce(getRunningProfileTypes)
      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })
    })
  })

  /**
   * @param {{ allocationProfilingAvailable?: boolean, cpuProfilingAvailable?: boolean }} capabilities
   *   Runtime capabilities the module sees
   */
  function enableWith (capabilities) {
    loadRemoteConfig(capabilities).enable(
      /** @type {import('../../src/remote_config')} */ (/** @type {unknown} */ (rc)),
      /** @type {ReturnType<import('../../src/config')>} */ (/** @type {unknown} */ (config)),
      getRunningProfileTypes
    )
  }

  describe('allocations', () => {
    it('maps allocations and runs the heap profiler for them where allocation profiling is available', () => {
      enableWith({ allocationProfilingAvailable: true })

      update({ toApply: [{ id: 'a', file: { profilers: { allocations: true, heapSize: false } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ALLOCATION_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('turns off allocations that were not running locally when turning profiling on', () => {
      enableWith({ allocationProfilingAvailable: true })
      getRunningProfileTypes.returns([])

      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ALLOCATION_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('keeps allocations that were running locally', () => {
      enableWith({ allocationProfilingAvailable: true })
      getRunningProfileTypes.returns(['space', 'allocations'])

      update({ toApply: [{ id: 'a', file: { profilers: { wallTime: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('keeps the heap profiler running for allocations that run locally', () => {
      enableWith({ allocationProfilingAvailable: true })
      getRunningProfileTypes.returns(['wall', 'cpu', 'space', 'allocations', 'events'])

      const profilers = { cpuTime: false, wallTime: false, heapSize: false, heapObjects: false }
      update({ toApply: [{ id: 'a', file: { profilers } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_CPU_ENABLED: 'false',
      })
    })

    it('disables profiling when allocations are turned off along with every other type', () => {
      enableWith({ allocationProfilingAvailable: true })
      getRunningProfileTypes.returns(['wall', 'cpu', 'space', 'allocations', 'events'])

      const profilers = { cpuTime: false, wallTime: false, heapSize: false, heapObjects: false, allocations: false }
      update({ toApply: [{ id: 'a', file: { profilers } }] })

      assert.strictEqual(currentSettings().DD_PROFILING_ENABLED, 'false')
    })

    it('ignores allocations where allocation profiling is unavailable', () => {
      enableWith({ allocationProfilingAvailable: false })

      const transaction = update({ toApply: [{ id: 'a', file: { profilers: { allocations: true } } }] })

      assert.strictEqual(currentSettings(), null)
      sinon.assert.notCalled(transaction.error)
    })
  })

  describe('CPU time where CPU profiling is unavailable', () => {
    beforeEach(() => {
      enableWith({ cpuProfilingAvailable: false })
      getRunningProfileTypes.returns(['wall', 'space'])
    })

    it('ignores CPU time', () => {
      const transaction = update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: true } } }] })

      assert.strictEqual(currentSettings(), null)
      sinon.assert.notCalled(transaction.error)
    })

    it('does not run the wall profiler for requested CPU time', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: true, wallTime: false, heapSize: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('disables profiling when the other profile types are turned off', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { wallTime: false, heapSize: false, heapObjects: false } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'false',
      })
    })
  })

  describe('updates', () => {
    it('does not touch the profiling layer for payloads without profiling content', () => {
      update({ toApply: [{ id: 'unrelated', file: { something: 'else' } }] })
      update({ toModify: [{ id: 'unrelated', file: { something: 'different' } }] })
      update({ toUnapply: [{ id: 'unrelated' }] })

      sinon.assert.notCalled(config.setRemoteConfig)
    })

    it('does not touch the profiling layer when the merged settings are unchanged', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })
      sinon.assert.calledOnce(config.setRemoteConfig)

      update({ toApply: [{ id: 'unrelated', file: { something: 'else' } }] })
      update({ toModify: [{ id: 'a', file: { profilers: { heapSize: true }, targets: [{ env: 'prod' }] } }] })
      update({ toApply: [{ id: 'b', file: { profilers: { heapSize: true } } }] })

      sinon.assert.calledOnce(config.setRemoteConfig)
    })

    it('writes the profiling layer again once the merged settings change', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })
      update({ toModify: [{ id: 'a', file: { profilers: { heapSize: false, heapObjects: false } } }] })
      update({ toUnapply: [{ id: 'a' }] })

      sinon.assert.calledThrice(config.setRemoteConfig)
      assert.deepStrictEqual(
        config.setRemoteConfig.secondCall.args,
        [{ DD_PROFILING_HEAP_ENABLED: 'false' }]
      )
      assert.deepStrictEqual(config.setRemoteConfig.thirdCall.args, [null])
    })
  })

  describe('heap objects', () => {
    it('runs the heap profiler for heap objects even when heap size is turned off', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapObjects: true, heapSize: false } } }] })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
    })

    it('runs the heap profiler for heap size even when heap objects are turned off', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true, heapObjects: false } } }] })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
    })

    it('turns off the heap profiler when both are turned off', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: false, heapObjects: false } } }] })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'false' })
    })

    it('leaves the heap profiler to local config when only one is turned off', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: false } } }] })
      assert.deepStrictEqual(currentSettings(), {})

      update({ toModify: [{ id: 'a', file: { profilers: { heapObjects: false } } }] })
      assert.deepStrictEqual(currentSettings(), {})
    })

    it('counts a locally running heap profiler as running heap objects', () => {
      getRunningProfileTypes.returns(['space'])

      update({ toApply: [{ id: 'a', file: { profilers: { wallTime: true } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('reports heap objects that are not a boolean', () => {
      const transaction = update({ toApply: [{ id: 'a', file: { profilers: { heapObjects: 1 } } }] })

      sinon.assert.calledOnceWithExactly(
        transaction.error,
        'datadog/2/APM_PROFILING/a/config',
        'profilers.heapObjects is not a boolean'
      )
    })
  })

  describe('mapping', () => {
    it('maps each requested profile type and enables profiling', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: true, wallTime: true, heapSize: true } } }] })

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

    it('leaves the enablement to local config while a locally running profiler keeps running', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: false, wallTime: false } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_CPU_ENABLED: 'false',
      })
    })

    it('disables profiling when the profile types running locally are turned off', () => {
      getRunningProfileTypes.returns(['wall', 'cpu', 'events'])

      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: false, wallTime: false } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'false',
      })
    })

    it('keeps the wall profiler running for CPU time that runs locally', () => {
      getRunningProfileTypes.returns(['wall', 'cpu'])

      update({ toApply: [{ id: 'a', file: { profilers: { wallTime: false } } }] })

      assert.deepStrictEqual(currentSettings(), {})
    })

    it('turns off the wall profiler when CPU time does not run locally', () => {
      getRunningProfileTypes.returns(['wall', 'space'])

      update({ toApply: [{ id: 'a', file: { profilers: { wallTime: false } } }] })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_WALLTIME_ENABLED: 'false' })
    })

    it('disables profiling when the heap profiler running locally is turned off', () => {
      getRunningProfileTypes.returns(['space'])

      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: false, heapObjects: false } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_HEAP_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'false',
      })
    })

    it('disables profiling when every profile type is turned off', () => {
      update({
        toApply: [{
          id: 'a',
          file: { profilers: { cpuTime: false, wallTime: false, heapSize: false, heapObjects: false } },
        }],
      })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'false',
      })
    })

    it('keeps profiling enabled while omitted heap objects keep the local heap profiler running', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { cpuTime: false, wallTime: false, heapSize: false } } }] })

      assert.strictEqual(currentSettings().DD_PROFILING_ENABLED, undefined)
    })

    it('ignores profile types this runtime does not collect', () => {
      const transaction = update({ toApply: [{ id: 'a', file: { profilers: { locks: true, exceptions: false } } }] })

      assert.strictEqual(currentSettings(), null)
      sinon.assert.notCalled(transaction.error)
    })

    it('ignores settings, as none are mapped yet', () => {
      const transaction = update({ toApply: [{ id: 'a', file: { settings: { stack_adaptive_sampling: true } } }] })

      assert.strictEqual(currentSettings(), null)
      sinon.assert.notCalled(transaction.error)
    })

    it('reverts to local config for an empty profilers section', () => {
      update({ toApply: [{ id: 'a', file: { profilers: {} } }] })

      assert.strictEqual(currentSettings(), null)
    })
  })

  describe('validation', () => {
    it('ignores payloads without a profilers or settings section', () => {
      const transaction = update({ toApply: [{ id: 'unrelated', file: { something: 'else' } }] })

      assert.strictEqual(currentSettings(), null)
      sinon.assert.calledOnceWithExactly(transaction.ack, 'datadog/2/APM_PROFILING/unrelated/config')
    })

    it('ignores payloads that are not objects', () => {
      update({ toApply: [{ id: 'a', file: null }, { id: 'b', file: 'profilers' }, { id: 'c', file: [] }] })

      assert.strictEqual(currentSettings(), null)
    })

    it('ignores fields of the wrong type and keeps the valid ones', () => {
      update({
        toApply: [{
          id: 'a',
          file: {
            profilers: { cpuTime: 'true', wallTime: 1, heapSize: true, unknown: true },
          },
        }],
      })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
    })

    it('ignores a config whose targets are not an array', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true }, targets: { service: 'my-service' } } }] })

      assert.strictEqual(currentSettings(), null)
    })

    it('ignores a config whose targets are all invalid instead of applying it everywhere', () => {
      update({
        toApply: [{
          id: 'a',
          file: { profilers: { heapSize: true }, targets: [{ service: 1 }, { tags: 'team:profiling' }, 'x'] },
        }],
      })

      assert.strictEqual(currentSettings(), null)
    })

    it('skips invalid targets and keeps the valid ones', () => {
      update({
        toApply: [{
          id: 'a',
          file: { profilers: { heapSize: true }, targets: [{ service: 1 }, { service: 'my-service' }] },
        }],
      })

      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
    })
  })

  describe('apply state', () => {
    const path = (id) => `datadog/2/APM_PROFILING/${id}/config`

    it('acknowledges valid payloads, including ones without profiling content', () => {
      const transaction = update({
        toApply: [
          { id: 'a', file: { profilers: { heapSize: true }, settings: {} } },
          { id: 'unrelated', file: { something: 'else' } },
        ],
      })

      sinon.assert.notCalled(transaction.error)
      sinon.assert.calledWithExactly(transaction.ack, path('a'))
      sinon.assert.calledWithExactly(transaction.ack, path('unrelated'))
    })

    it('reports payloads that are not objects as errors', () => {
      const transaction = update({ toApply: [{ id: 'text', file: 'text' }, { id: 'array', file: [] }] })

      sinon.assert.notCalled(transaction.ack)
      sinon.assert.calledWithExactly(transaction.error, path('text'), 'payload is not an object')
      sinon.assert.calledWithExactly(transaction.error, path('array'), 'payload is not an object')
    })

    it('reports a partially invalid profiling payload as an error and still applies its valid fields', () => {
      const transaction = update({
        toApply: [{
          id: 'a',
          file: {
            profilers: { cpuTime: 'true', heapSize: true },
            settings: 'fast',
            targets: [{ service: 'my-service' }, { env: 1 }],
          },
        }],
      })

      sinon.assert.notCalled(transaction.ack)
      sinon.assert.calledOnceWithExactly(
        transaction.error,
        path('a'),
        'targets[1] is invalid; profilers.cpuTime is not a boolean; settings is not an object'
      )
      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
    })

    it('reports invalid sections as errors', () => {
      const transaction = update({ toApply: [{ id: 'a', file: { profilers: [], settings: 'fast' } }] })

      sinon.assert.calledOnceWithExactly(
        transaction.error,
        path('a'),
        'profilers is not an object; settings is not an object'
      )
    })

    it('reports a config dropped for its targets as an error', () => {
      const transaction = update({
        toApply: [
          { id: 'not-array', file: { profilers: { heapSize: true }, targets: {} } },
          { id: 'all-invalid', file: { profilers: { heapSize: true }, targets: ['x'] } },
        ],
      })

      sinon.assert.calledWithExactly(transaction.error, path('not-array'), 'targets is not an array')
      sinon.assert.calledWithExactly(transaction.error, path('all-invalid'), 'targets[0] is invalid; no valid targets')
      assert.strictEqual(currentSettings(), null)
    })
  })

  describe('targets', () => {
    // A config with heap turned off and the given targets, merged with an untargeted one with heapSize: true:
    // the result shows whether the targeted config ranked above the untargeted one.
    /**
     * @param {object[]} targets
     */
    function outranksUntargeted (targets) {
      update({
        toApply: [
          { id: 'a-targeted', file: { profilers: { heapSize: false, heapObjects: false }, targets } },
          { id: 'z-untargeted', file: { profilers: { heapSize: true } } },
        ],
      })
      return currentSettings().DD_PROFILING_HEAP_ENABLED === 'false'
    }

    it('applies every received config, whatever its targets', () => {
      for (const targets of [
        [{ service: 'other-service' }],
        [{ service: 'my-service', env: 'staging' }],
        [{ tags: ['kube_pod_name:not-known-to-the-tracer'] }],
      ]) {
        update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true }, targets } }] })
        assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'true', DD_PROFILING_ENABLED: 'true' })
        update({ toUnapply: [{ id: 'a' }] })
      }
    })

    it('ranks a config by its targets consistent with the service and env', () => {
      assert.strictEqual(outranksUntargeted([{ service: 'my-service', env: 'prod' }]), true)
      assert.strictEqual(outranksUntargeted([{ env: 'prod' }]), true)
    })

    it('ranks a config without a consistent target lowest', () => {
      // Ties with the untargeted config are broken by id, which puts the untargeted one last.
      assert.strictEqual(outranksUntargeted([{ service: 'other-service' }, { env: 'staging' }]), false)
    })

    it('ignores inconsistent targets when ranking a config', () => {
      update({
        toApply: [
          // Its service+env target names another service, so it ranks as an env target.
          {
            id: 'a',
            file: {
              profilers: { heapSize: false, heapObjects: false },
              targets: [{ service: 'other-service', env: 'prod' }, { env: 'prod' }],
            },
          },
          { id: 'b', file: { profilers: { heapSize: true }, targets: [{ service: 'my-service' }] } },
        ],
      })

      assert.strictEqual(currentSettings().DD_PROFILING_HEAP_ENABLED, 'true')
    })

    // Merges a config with heap turned off and the targets `higher` with one with heapSize: true and the
    // targets `lower`. The config with heapSize: true wins ties (by id), so heap is off only when `higher`
    // really ranks above `lower`.
    /**
     * @param {object[]} higher
     * @param {object[]} lower
     */
    function outranks (higher, lower) {
      update({ toUnapply: [{ id: 'a-higher' }, { id: 'z-lower' }] })
      update({
        toApply: [
          { id: 'a-higher', file: { profilers: { heapSize: false, heapObjects: false }, targets: higher } },
          { id: 'z-lower', file: { profilers: { heapSize: true }, targets: lower } },
        ],
      })
      return currentSettings().DD_PROFILING_HEAP_ENABLED === 'false'
    }

    it('ranks targets as other tags < env < service < workload < container name < pod < container ID', () => {
      const ordered = [
        [],
        [{ tags: ['kube_namespace:ns'] }],
        [{ env: 'prod' }],
        [{ service: 'my-service' }],
        [{ tags: ['kube_deployment:d'] }],
        [{ tags: ['kube_container_name:c'] }],
        [{ tags: ['pod_name:p'] }],
        [{ tags: ['container_id:abc'] }],
      ]
      for (let index = 1; index < ordered.length; index++) {
        assert.strictEqual(outranks(ordered[index], ordered[index - 1]), true, JSON.stringify(ordered[index]))
        assert.strictEqual(outranks(ordered[index - 1], ordered[index]), false, JSON.stringify(ordered[index]))
      }
    })

    it('recognizes every tag name of a level', () => {
      for (const name of ['kube_deployment', 'kube_replica_set', 'kube_stateful_set', 'kube_daemon_set', 'kube_job',
        'kube_cronjob', 'kube_argo_rollout', 'oshift_deployment', 'task_family']) {
        assert.strictEqual(outranks([{ tags: [`${name}:x`] }], [{ service: 'my-service', env: 'prod' }]), true, name)
        assert.strictEqual(outranks([{ tags: [`${name}:x`] }], [{ tags: ['container_name:x'] }]), false, name)
      }
      for (const name of ['kube_container_name', 'container_name', 'ecs_container_name']) {
        assert.strictEqual(outranks([{ tags: [`${name}:x`] }], [{ tags: ['kube_deployment:x'] }]), true, name)
        assert.strictEqual(outranks([{ tags: [`${name}:x`] }], [{ tags: ['pod_name:x'] }]), false, name)
      }
      for (const name of ['pod_name', 'task_arn']) {
        assert.strictEqual(outranks([{ tags: [`${name}:x`] }], [{ tags: ['container_name:x'] }]), true, name)
        assert.strictEqual(outranks([{ tags: [`${name}:x`] }], [{ tags: ['container_id:x'] }]), false, name)
      }
    })

    it('lets a pod-specific config override a service-wide one, as in the payload merging ADR', () => {
      update({
        toApply: [
          {
            id: 'service',
            file: { profilers: { cpuTime: true, heapSize: false }, targets: [{ service: 'my-service' }] },
          },
          { id: 'pod', file: { profilers: { heapSize: true }, targets: [{ tags: ['pod_name:my-service-abcdef'] }] } },
        ],
      })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'true',
        DD_PROFILING_CPU_ENABLED: 'true',
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })
    })

    it('ranks a combined target by its most specific condition, then by its number of conditions', () => {
      assert.strictEqual(outranks([{ service: 'my-service', tags: ['pod_name:p'] }], [{ tags: ['kube_deployment:d'] }]),
        true)
      assert.strictEqual(outranks([{ service: 'my-service', tags: ['pod_name:p'] }], [{ tags: ['pod_name:p'] }]), true)
      assert.strictEqual(outranks([{ service: 'my-service', env: 'prod' }], [{ service: 'my-service' }]), true)
      assert.strictEqual(outranks([{ env: 'prod', tags: ['team:a', 'region:b'] }], [{ service: 'my-service' }]), false)
    })

    it('compares normalized service and env', () => {
      assert.strictEqual(outranks([{ service: 'My-Service', env: 'PROD' }], [{ env: 'prod' }]), true)
    })

    it('assumes the tag conditions of a target hold', () => {
      assert.strictEqual(outranksUntargeted([{ tags: ['kube_pod_name:not-known-to-the-tracer'] }]), true)
      update({ toUnapply: [{ id: 'a-targeted' }, { id: 'z-untargeted' }] })
      assert.strictEqual(outranksUntargeted([{ service: 'my-service', tags: ['team:other'] }]), true)
    })
  })

  describe('merging', () => {
    it('lets more specific configs win, field by field', () => {
      update({
        toApply: [
          {
            id: 'service-env',
            file: {
              profilers: { heapSize: false, heapObjects: false },
              targets: [{ service: 'my-service', env: 'prod' }],
            },
          },
          { id: 'service', file: { profilers: { wallTime: false }, targets: [{ service: 'my-service' }] } },
          { id: 'env', file: { profilers: { wallTime: true }, targets: [{ env: 'prod' }] } },
          { id: 'tags', file: { profilers: { cpuTime: false }, targets: [{ tags: ['team:profiling'] }] } },
          { id: 'org', file: { profilers: { cpuTime: true, heapSize: true } } },
        ],
      })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_WALLTIME_ENABLED: 'false',
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'false',
        DD_PROFILING_ENABLED: 'false',
      })
    })

    it('breaks ties between equally specific configs by id, independent of delivery order', () => {
      const first = { id: 'a', file: { profilers: { heapSize: true } } }
      const second = { id: 'b', file: { profilers: { heapSize: false, heapObjects: false } } }

      update({ toApply: [first, second] })
      const inOrder = currentSettings()
      update({ toUnapply: [first, second] })
      update({ toApply: [second, first] })

      assert.deepStrictEqual(currentSettings(), inOrder)
      assert.strictEqual(inOrder.DD_PROFILING_HEAP_ENABLED, 'false')
    })

    it('keeps configs across updates and drops them on unapply', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })
      update({ toApply: [{ id: 'b', file: { profilers: { cpuTime: false } } }] })

      assert.deepStrictEqual(currentSettings(), {
        DD_PROFILING_CPU_ENABLED: 'false',
        DD_PROFILING_HEAP_ENABLED: 'true',
        DD_PROFILING_ENABLED: 'true',
      })

      update({ toUnapply: [{ id: 'a' }] })
      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_CPU_ENABLED: 'false' })

      update({ toUnapply: [{ id: 'b' }] })
      assert.strictEqual(currentSettings(), null)
    })

    it('replaces a config on modify, and drops it when it no longer carries profiling content', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })
      update({ toModify: [{ id: 'a', file: { profilers: { heapSize: false, heapObjects: false } } }] })
      assert.deepStrictEqual(currentSettings(), { DD_PROFILING_HEAP_ENABLED: 'false' })

      update({ toModify: [{ id: 'a', file: { unrelated: true } }] })
      assert.strictEqual(currentSettings(), null)
    })

    it('acknowledges every item', () => {
      update({ toApply: [{ id: 'a', file: { profilers: { heapSize: true } } }] })
      const transaction = update({
        toApply: [{ id: 'b', file: { profilers: { heapSize: true } } }],
        toModify: [{ id: 'c', file: { nothing: 'here' } }],
        toUnapply: [{ id: 'a' }],
      })

      sinon.assert.calledThrice(transaction.ack)
      sinon.assert.notCalled(transaction.error)
    })
  })
})
