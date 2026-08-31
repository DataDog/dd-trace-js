'use strict'

const assert = require('node:assert/strict')

const { setup } = require('./utils')

const MAX_SNAPSHOTS_PER_SECOND_GLOBALLY = 25

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  describe('sampling', function () {
    it('should apply the sampling rate independently per probe', async function () {
      const rcConfig1 = t.breakpoints[0].generateRemoteConfig({ sampling: { snapshotsPerSecond: 0.001 } })
      const rcConfig2 = t.breakpoints[1].generateRemoteConfig({ sampling: { snapshotsPerSecond: 0.001 } })
      const probeIds = [rcConfig1.config.id, rcConfig2.config.id]
      const probesInstalled = t.waitForProbeStatus(probeIds, 'INSTALLED')

      t.agent.addRemoteConfig(rcConfig1)
      t.agent.addRemoteConfig(rcConfig2)
      await probesInstalled

      const snapshots = await t.captureSnapshotsUntilExit(probeIds.length, async () => {
        const responses = await Promise.all([
          t.axios.get(t.breakpoints[0].url),
          t.axios.get(t.breakpoints[0].url),
          t.axios.get(t.breakpoints[1].url),
          t.axios.get(t.breakpoints[1].url),
        ])
        for (const response of responses) {
          assert.strictEqual(response.status, 200)
        }
      })

      assert.deepStrictEqual(
        snapshots.map(({ probe }) => probe.id).sort(),
        probeIds.sort()
      )
    })

    it('should limit snapshots across probes at different locations', async function () {
      const rcConfigs = []
      for (let i = 0; i < MAX_SNAPSHOTS_PER_SECOND_GLOBALLY + 1; i++) {
        const breakpoint = t.breakpoints[i % 2]
        rcConfigs.push(breakpoint.generateRemoteConfig({
          captureSnapshot: true,
          sampling: { snapshotsPerSecond: 5000 },
        }))
      }
      const probeIds = rcConfigs.map(({ config }) => config.id)
      const probesInstalled = t.waitForProbeStatus(probeIds, 'INSTALLED')

      for (const rcConfig of rcConfigs) {
        t.agent.addRemoteConfig(rcConfig)
      }
      await probesInstalled

      const snapshots = await t.captureSnapshotsUntilExit(MAX_SNAPSHOTS_PER_SECOND_GLOBALLY, async () => {
        const responses = await Promise.all([
          t.axios.get(t.breakpoints[0].url),
          t.axios.get(t.breakpoints[1].url),
        ])
        for (const response of responses) {
          assert.strictEqual(response.status, 200)
        }
      })

      assert.strictEqual(snapshots.length, MAX_SNAPSHOTS_PER_SECOND_GLOBALLY)
      const expectedProbeIds = new Set(probeIds)
      const snapshotProbeIds = new Set()
      for (const { probe } of snapshots) {
        assert.ok(expectedProbeIds.has(probe.id), `Unexpected probe ID: ${probe.id}`)
        snapshotProbeIds.add(probe.id)
      }
      assert.strictEqual(snapshotProbeIds.size, MAX_SNAPSHOTS_PER_SECOND_GLOBALLY)
    })
  })
})
