'use strict'

const assert = require('node:assert/strict')

const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  describe('race conditions', function () {
    it('should remove the last breakpoint completely before trying to add a new one', async function () {
      const rcConfig2 = t.generateRemoteConfig()
      const firstProbeInstalled = t.waitForProbeStatus([t.rcConfig.config.id], 'INSTALLED')

      t.agent.addRemoteConfig(t.rcConfig)
      await firstProbeInstalled

      const secondProbeInstalled = t.waitForProbeStatus([rcConfig2.config.id], 'INSTALLED')
      t.agent.removeRemoteConfig(t.rcConfig.id)
      t.agent.addRemoteConfig(rcConfig2)
      await secondProbeInstalled

      const snapshots = await t.captureSnapshotsUntilExit(1, async () => {
        const response = await t.axios.get(t.breakpoint.url)
        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(response.data, { hello: 'bar' })
      })

      assert.deepStrictEqual(snapshots.map(({ probe }) => probe.id), [rcConfig2.config.id])
    })
  })
})
