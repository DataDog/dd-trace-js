'use strict'

const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')

const { setup } = require('./utils')

/**
 * @param {ReturnType<typeof setup>} t
 * @param {Array<{ config: { id: string, config: { id: string } }, url: string }>} probes
 * @returns {Promise<Map<string, number[]>>}
 */
async function captureSamplingIntervals (t, probes) {
  const expectedSamplesPerProbe = 2
  const probeIds = probes.map(({ config }) => config.config.id)
  const probesInstalled = t.waitForProbeStatus(probeIds, 'INSTALLED')

  for (const { config } of probes) {
    t.agent.addRemoteConfig(config)
  }
  await probesInstalled

  const timestampsByProbeId = new Map(probeIds.map(probeId => [probeId, []]))
  let captureError
  let rejectSamples
  let resolveSamples
  const samplesReceived = new Promise((resolve, reject) => {
    rejectSamples = reject
    resolveSamples = resolve
  })

  /** @param {Error} error */
  function rejectCapture (error) {
    captureError = error
    rejectSamples(error)
  }

  /** @param {{ payload: Array<{ debugger: { snapshot: { probe: { id: string }, timestamp: number } } }> }} event */
  function handleSnapshots ({ payload }) {
    try {
      for (const { debugger: { snapshot } } of payload) {
        const timestamps = timestampsByProbeId.get(snapshot.probe.id)
        assert.ok(timestamps, `Unexpected probe ID: ${snapshot.probe.id}`)
        timestamps.push(snapshot.timestamp)
      }

      for (const timestamps of timestampsByProbeId.values()) {
        if (timestamps.length < expectedSamplesPerProbe) return
      }
      resolveSamples()
    } catch (error) {
      rejectCapture(error)
    }
  }

  t.agent.on('debugger-input', handleSnapshots)
  const timers = probes.map(({ url }) => setInterval(() => {
    t.request(url).catch(rejectCapture)
  }, 10))

  try {
    try {
      await samplesReceived
    } finally {
      for (const timer of timers) clearInterval(timer)
    }

    // Keep collecting after requests stop so late payloads remain observable for a full sampling period.
    await delay(1250)
    if (captureError) throw captureError
    return timestampsByProbeId
  } finally {
    t.agent.removeListener('debugger-input', handleSnapshots)
  }
}

/** @param {number[]} timestamps */
function assertSamplingInterval (timestamps) {
  assert.strictEqual(timestamps.length, 2)

  // Snapshot timestamps use wall-clock time while sampling uses monotonic time, so allow 75ms for drift.
  for (let i = 1; i < timestamps.length; i++) {
    const duration = timestamps[i] - timestamps[i - 1]
    assert.ok(duration >= 925, `duration (${duration}) should be >= 925`)
    assert.ok(duration < 1075, `duration (${duration}) should be < 1075`)
  }
}

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  describe('sampling', function () {
    it('should respect sampling rate for single probe', async function () {
      const rcConfig = t.generateRemoteConfig({ sampling: { snapshotsPerSecond: 1 } })
      const timestampsByProbeId = await captureSamplingIntervals(t, [{
        config: rcConfig,
        url: t.breakpoint.url,
      }])

      assertSamplingInterval(timestampsByProbeId.get(rcConfig.config.id))
    })

    it('should adhere to individual probes sample rate', async function () {
      const rcConfig1 = t.breakpoints[0].generateRemoteConfig({ sampling: { snapshotsPerSecond: 1 } })
      const rcConfig2 = t.breakpoints[1].generateRemoteConfig({ sampling: { snapshotsPerSecond: 1 } })
      const timestampsByProbeId = await captureSamplingIntervals(t, [{
        config: rcConfig1,
        url: t.breakpoints[0].url,
      }, {
        config: rcConfig2,
        url: t.breakpoints[1].url,
      }])

      assertSamplingInterval(timestampsByProbeId.get(rcConfig1.config.id))
      assertSamplingInterval(timestampsByProbeId.get(rcConfig2.config.id))
    })
  })
})
