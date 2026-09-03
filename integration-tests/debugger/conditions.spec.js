'use strict'

const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')

const { stopProc } = require('../helpers')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  describe('condition', function () {
    it('should trigger when condition is met', async function () {
      const rcConfig = t.generateRemoteConfig({
        when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'bar'] } },
      })
      const probeInstalled = t.waitForProbeStatus([rcConfig.config.id], 'INSTALLED')

      t.agent.addRemoteConfig(rcConfig)
      await probeInstalled

      const snapshots = await t.captureSnapshotsUntilExit(1, async () => {
        const response = await t.request(t.breakpoint.url)
        assert.strictEqual(response.status, 200)
      })

      assert.deepStrictEqual(snapshots.map(({ probe }) => probe.id), [rcConfig.config.id])
    })

    it('should not trigger when condition is not met', async function () {
      const rcConfig = t.generateRemoteConfig({
        when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'invalid'] } },
      })
      const probeInstalled = t.waitForProbeStatus([rcConfig.config.id], 'INSTALLED')

      t.agent.addRemoteConfig(rcConfig)
      await probeInstalled

      const snapshots = await t.captureSnapshotsUntilExit(0, async () => {
        const response = await t.request(t.breakpoint.url)
        assert.strictEqual(response.status, 200)
        await delay(2000)
      })

      assert.deepStrictEqual(snapshots, [])
    })

    it('should report error if condition cannot be compiled', async function () {
      const rcConfig = t.generateRemoteConfig({
        when: { dsl: 'original dsl', json: { ref: 'this is not a valid ref' } },
      })

      const statuses = []
      /** @param {{ payload: Array<{ debugger: { diagnostics: { probeId: string, status: string } } }> }} event */
      function recordStatuses ({ payload }) {
        for (const { debugger: { diagnostics } } of payload) {
          if (diagnostics.probeId === rcConfig.config.id) statuses.push(diagnostics.status)
        }
      }

      const errorReceived = t.waitForProbeStatus([rcConfig.config.id], 'ERROR')
      t.agent.on('debugger-diagnostics', recordStatuses)
      try {
        t.agent.addRemoteConfig(rcConfig)
        const diagnosticsByProbeId = await errorReceived
        await stopProc(t.proc)

        assert.strictEqual(
          diagnosticsByProbeId.get(rcConfig.config.id).exception.message,
          `Cannot compile expression: original dsl (probe: ${rcConfig.config.id}, version: 0)`
        )
        assert.ok(!statuses.includes('INSTALLED'), 'Probe should not install when condition compilation fails')
      } finally {
        t.agent.removeListener('debugger-diagnostics', recordStatuses)
      }
    })
  })
})
