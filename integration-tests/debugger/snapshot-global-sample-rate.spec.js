'use strict'

const assert = require('node:assert/strict')

const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({
    testApp: 'target-app/basic.js',
    dependencies: ['fastify'],
  })

  describe('input messages', function () {
    describe('with snapshot', function () {
      it('should respect global max snapshot sampling rate', async function () {
        const maxSnapshotsPerSecond = 25
        const probeConfig = {
          captureSnapshot: true,
          sampling: { snapshotsPerSecond: maxSnapshotsPerSecond * 2 },
        }
        const rcConfig1 = t.breakpoints[0].generateRemoteConfig(probeConfig)
        const rcConfig2 = t.breakpoints[1].generateRemoteConfig(probeConfig)
        const probeIds = [rcConfig1.config.id, rcConfig2.config.id]
        const probesInstalled = t.waitForProbeStatus(probeIds, 'INSTALLED')
        const timestamps = []
        let rejectSnapshots
        let resolveSnapshots
        const snapshotsReceived = new Promise((resolve, reject) => {
          rejectSnapshots = reject
          resolveSnapshots = resolve
        })

        /** @param {{ payload: Array<{ debugger: { snapshot: { timestamp: number } } }> }} event */
        function handleSnapshots ({ payload }) {
          try {
            for (const { debugger: { snapshot } } of payload) {
              if (timestamps.length === maxSnapshotsPerSecond + 1) return
              timestamps.push(snapshot.timestamp)
              if (timestamps.length === maxSnapshotsPerSecond + 1) resolveSnapshots()
            }
          } catch (error) {
            rejectSnapshots(error)
          }
        }

        t.agent.on('debugger-input', handleSnapshots)
        t.agent.addRemoteConfig(rcConfig1)
        t.agent.addRemoteConfig(rcConfig2)
        await probesInstalled

        const requestsPerInterval = 4
        const timers = [t.breakpoints[0].url, t.breakpoints[1].url].map(url => setInterval(() => {
          for (let i = 0; i < requestsPerInterval; i++) {
            t.axios.get(url).catch(rejectSnapshots)
          }
        }, 10))

        try {
          await snapshotsReceived
        } finally {
          for (const timer of timers) clearInterval(timer)
          t.agent.removeListener('debugger-input', handleSnapshots)
        }

        assert.strictEqual(timestamps.length, maxSnapshotsPerSecond + 1)
        const duration = timestamps[maxSnapshotsPerSecond] - timestamps[0]
        const quietPeriod = timestamps[maxSnapshotsPerSecond] - timestamps[maxSnapshotsPerSecond - 1]

        assert.ok(duration >= 925, `Expected ${duration} >= 925`)
        assert.ok(duration < 1050, `Expected ${duration} < 1050`)
        assert.ok(quietPeriod >= 250, `Expected ${quietPeriod} >= 250`)
      })
    })
  })
})
