'use strict'

const assert = require('node:assert/strict')

const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  describe('race conditions', function () {
    it('should remove the last breakpoint completely before trying to add a new one', async function () {
      this.timeout(5000)

      const rcConfig2 = t.generateRemoteConfig()
      const secondProbeInstalled = t.waitForProbeStatus([rcConfig2.config.id], 'INSTALLED')
      const firstProbeReplaced = new Promise(resolve => {
        t.agent.on('debugger-diagnostics', function replaceProbe ({ payload }) {
          for (const event of payload) {
            const { probeId, status } = event.debugger.diagnostics
            if (probeId !== t.rcConfig.config.id || status !== 'INSTALLED') continue

            t.agent.removeListener('debugger-diagnostics', replaceProbe)
            t.agent.removeRemoteConfig(t.rcConfig.id)
            t.agent.addRemoteConfig(rcConfig2)
            resolve()
            return
          }
        })
      })

      t.agent.addRemoteConfig(t.rcConfig)
      await Promise.all([firstProbeReplaced, secondProbeInstalled])

      const snapshots = await t.captureSnapshotsUntilExit(1, async () => {
        const response = await t.axios.get(t.breakpoint.url)
        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(response.data, { hello: 'bar' })
      })

      assert.deepStrictEqual(snapshots.map(({ probe }) => probe.id), [rcConfig2.config.id])
    })
  })
})
