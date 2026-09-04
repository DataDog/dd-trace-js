'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { setup } = require('./utils')

// The guardrail counters are converted into telemetry metrics every 10 seconds, which are then sent on the next
// telemetry heartbeat
const GUARDRAIL_METRICS_FLUSH_INTERVAL_MS = 10_000
const TELEMETRY_HEARTBEAT_INTERVAL_SECONDS = 1

describe('Dynamic Instrumentation', function () {
  const t = setup({
    testApp: 'target-app/basic.js',
    dependencies: ['fastify'],
    env: {
      DD_TELEMETRY_HEARTBEAT_INTERVAL: String(TELEMETRY_HEARTBEAT_INTERVAL_SECONDS),
      // The app-started event is sent before the test can listen for it, but the extended heartbeat repeats its
      // application payload
      DD_TELEMETRY_EXTENDED_HEARTBEAT_INTERVAL: String(TELEMETRY_HEARTBEAT_INTERVAL_SECONDS),
    },
  })

  describe('guardrail telemetry', function () {
    this.timeout(GUARDRAIL_METRICS_FLUSH_INTERVAL_MS * 3)

    it('should report Dynamic Instrumentation as an enabled product', async function () {
      await t.agent.assertTelemetryReceived({
        fn: ({ payload }) => {
          assert.deepStrictEqual(payload.payload.products.dynamic_instrumentation, { enabled: true })
        },
        requestType: 'app-extended-heartbeat',
      })
    })

    it('should report skipped events and incomplete captures', async function () {
      // A log probe that is hit far more often than its per-probe rate limit allows
      const rateLimitedProbe = t.breakpoints[0].generateRemoteConfig({ sampling: { snapshotsPerSecond: 1 } })
      // A snapshot probe that cannot capture the request object within its reference depth limit
      const shallowSnapshotProbe = t.breakpoints[1].generateRemoteConfig({
        captureSnapshot: true,
        capture: { maxReferenceDepth: 0 },
      })

      const installed = new Set()
      const allInstalled = new Promise((/** @type {(value?: void) => void} */ resolve) => {
        t.agent.on('debugger-diagnostics', ({ payload }) => {
          for (const { debugger: { diagnostics: { probeId, status } } } of payload) {
            if (status === 'INSTALLED') installed.add(probeId)
          }
          if (installed.size === 2) resolve()
        })
      })

      const checkMetrics = t.agent.assertTelemetryReceived({
        fn: ({ payload }) => {
          const { series } = payload.payload

          const skipped = findMetric(series, 'events.skipped', ['event_type:log', 'reason:rateLimitProbe'])
          assert.strictEqual(skipped.type, 'count')
          assert.strictEqual(skipped.common, true)
          assert.strictEqual(skipped.points.length, 1)
          assert.ok(skipped.points[0][1] >= 1, `Expected ${skipped.points[0][1]} >= 1`)

          const incomplete = findMetric(series, 'capture.incomplete', ['event_type:snapshot', 'reason:depth'])
          assert.strictEqual(incomplete.type, 'count')
          assert.strictEqual(incomplete.common, true)
          assert.strictEqual(incomplete.points.length, 1)
          assert.strictEqual(incomplete.points[0][1], 1)
        },
        requestType: 'generate-metrics',
        timeout: GUARDRAIL_METRICS_FLUSH_INTERVAL_MS * 2,
        resolveAtFirstSuccess: true,
        namespace: 'live_debugger',
      })

      t.agent.addRemoteConfig(rateLimitedProbe)
      t.agent.addRemoteConfig(shallowSnapshotProbe)
      await allInstalled

      // Trigger the rate limited probe well within a single second, so all but the first hit are skipped
      await Promise.all(Array.from({ length: 5 }, () => t.request(t.breakpoints[0].url)))
      await t.request(t.breakpoints[1].url)

      await checkMetrics
    })
  })
})

/**
 * @param {Array<{ metric: string, tags: string[] }>} series - The telemetry metric series
 * @param {string} metric - The metric name to find
 * @param {string[]} tags - The exact tags the metric must carry
 * @returns {object} The matching series entry
 */
function findMetric (series, metric, tags) {
  const match = series.find((entry) => {
    return entry.metric === metric && entry.tags.length === tags.length && tags.every((tag) => entry.tags.includes(tag))
  })
  assert.ok(match, `Expected metric ${metric} with tags ${inspect(tags)} in ${inspect(series)}`)
  return match
}
