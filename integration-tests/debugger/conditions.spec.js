'use strict'

const assert = require('node:assert/strict')

const { stopProc } = require('../helpers')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  describe('condition', function () {
    it('should only trigger when condition is met', async function () {
      const matchingConfig = t.generateRemoteConfig({
        when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'bar'] } },
      })
      const nonMatchingConfig = t.generateRemoteConfig({
        when: { json: { eq: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, 'invalid'] } },
      })

      const probesInstalled = t.waitForProbeStatus([
        matchingConfig.config.id,
        nonMatchingConfig.config.id,
      ], 'INSTALLED')
      t.agent.addRemoteConfig(matchingConfig)
      t.agent.addRemoteConfig(nonMatchingConfig)
      await probesInstalled

      const snapshots = await t.captureSnapshotsUntilExit(1, async () => {
        const response = await t.axios.get(t.breakpoint.url)
        assert.strictEqual(response.status, 200)
      })

      assert.deepStrictEqual(snapshots.map(({ probe }) => probe.id), [matchingConfig.config.id])
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
