'use strict'

const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')

const { setup } = require('./utils')

/**
 * @typedef {object} ReceivedSnapshot
 * @property {string} probeId
 * @property {string | undefined} traceId
 */

// How long to keep listening for snapshots that should not arrive, once the expected ones have
const GRACE_PERIOD_MS = 500

describe('Dynamic Instrumentation', function () {
  const t = setup({ dependencies: ['fastify'] })

  describe('coordinated sampling', function () {
    it('should emit the snapshots of all probes hit in a trace, or none of them', async function () {
      const [first, second, third] = t.breakpoints
      const probes = {
        // Sampled at most once per 10 seconds, so the second trace it starts is dropped
        first: first.generateRemoteConfig({ captureSnapshot: true, sampling: { snapshotsPerSecond: 0.1 } }),
        // Hit just before the first trace, so it would be rate limited in that trace if sampled on its own
        second: second.generateRemoteConfig({ captureSnapshot: true, sampling: { snapshotsPerSecond: 1 } }),
        // Practically not rate limited, so it would emit in the dropped trace if sampled on its own
        third: third.generateRemoteConfig({ captureSnapshot: true, sampling: { snapshotsPerSecond: 1000 } }),
      }
      await installProbes(Object.values(probes))
      const { snapshots, waitForCount } = collectSnapshots()

      const { body: { traceId: secondTraceId } } = await t.request('/second')
      const { body: { traceId: sampledTraceId } } = await t.request('/chain')
      const { body: { traceId: droppedTraceId } } = await t.request('/chain')
      await waitForCount(4)
      await delay(GRACE_PERIOD_MS)

      assert.notStrictEqual(sampledTraceId, droppedTraceId)
      assert.deepStrictEqual(groupProbeNamesByTrace(snapshots, probes), new Map([
        [secondTraceId, ['second']],
        [sampledTraceId, ['first', 'second', 'third']],
      ]))
    })

    it('should emit one snapshot per probe per trace', async function () {
      const [,,,, loopBody, afterLoop] = t.breakpoints
      const probes = {
        loopBody: loopBody.generateRemoteConfig({ captureSnapshot: true, sampling: { snapshotsPerSecond: 1000 } }),
        afterLoop: afterLoop.generateRemoteConfig({ captureSnapshot: true, sampling: { snapshotsPerSecond: 1000 } }),
      }
      await installProbes(Object.values(probes))
      const { snapshots, waitForCount } = collectSnapshots()

      const { body: { traceId } } = await t.request('/loop')
      await waitForCount(2)
      await delay(GRACE_PERIOD_MS)

      assert.deepStrictEqual(groupProbeNamesByTrace(snapshots, probes), new Map([
        [traceId, ['afterLoop', 'loopBody']],
      ]))
    })

    it('should sample probes independently when hit in a trace that has finished', async function () {
      const [,,, leaked] = t.breakpoints
      // Without the fallback to independent sampling, the probe would emit only once in the finished trace
      const probe = leaked.generateRemoteConfig({ captureSnapshot: true, sampling: { snapshotsPerSecond: 10 } })
      await installProbes([probe])
      const { snapshots, waitForCount } = collectSnapshots()

      const { body: { traceId } } = await t.request('/leak')
      await waitForCount(2)

      for (const snapshot of snapshots) {
        assert.strictEqual(snapshot.probeId, probe.config.id)
        assert.strictEqual(snapshot.traceId, traceId)
      }
    })
  })

  /**
   * Install probes and wait until all of them are installed.
   *
   * @param {Array<{ product: string, id: string, config: { id: string } }>} rcConfigs - The remote configs of the
   *   probes to install.
   */
  async function installProbes (rcConfigs) {
    const probesInstalled = t.waitForProbeStatus(rcConfigs.map(({ config }) => config.id), 'INSTALLED')
    for (const rcConfig of rcConfigs) {
      t.agent.addRemoteConfig(rcConfig)
    }
    await probesInstalled
  }

  /**
   * Collect the snapshots received by the agent from now on.
   *
   * @returns {{ snapshots: ReceivedSnapshot[], waitForCount: (count: number) => Promise<void> }}
   */
  function collectSnapshots () {
    /** @type {ReceivedSnapshot[]} */
    const snapshots = []
    /** @type {Array<{ count: number, resolve: () => void }>} */
    const waiters = []

    t.agent.on('debugger-input', ({ payload }) => {
      for (const { dd, debugger: { snapshot } } of payload) {
        snapshots.push({ probeId: snapshot.probe.id, traceId: dd?.trace_id })
      }
      for (const waiter of waiters) {
        if (snapshots.length >= waiter.count) waiter.resolve()
      }
    })

    return {
      snapshots,
      waitForCount (count) {
        return new Promise((resolve) => {
          if (snapshots.length >= count) return resolve()
          waiters.push({ count, resolve })
        })
      },
    }
  }
})

/**
 * Group the names of the probes that emitted snapshots by the trace they were emitted in.
 *
 * @param {ReceivedSnapshot[]} snapshots - The received snapshots.
 * @param {Record<string, { config: { id: string } }>} probes - The remote configs of the probes, by name.
 * @returns {Map<string | undefined, string[]>} The sorted probe names, by trace id.
 */
function groupProbeNamesByTrace (snapshots, probes) {
  const nameById = new Map(Object.entries(probes).map(([name, { config }]) => [config.id, name]))
  /** @type {Map<string | undefined, string[]>} */
  const namesByTrace = new Map()
  for (const { probeId, traceId } of snapshots) {
    const names = namesByTrace.get(traceId) ?? []
    names.push(/** @type {string} */ (nameById.get(probeId)))
    namesByTrace.set(traceId, names)
  }
  for (const names of namesByTrace.values()) names.sort()
  return namesByTrace
}
