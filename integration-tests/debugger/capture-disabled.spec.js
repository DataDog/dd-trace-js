'use strict'

const assert = require('node:assert/strict')
const { setTimeout: sleep } = require('node:timers/promises')
const { inspect } = require('node:util')

const { setup } = require('./utils')

// The guardrail counters are converted into telemetry metrics every 10 seconds, which are then sent on the next
// telemetry heartbeat
const GUARDRAIL_METRICS_FLUSH_INTERVAL_MS = 10_000

// The probe is limited to one event per second, so two hits in quick succession skip the second one
const PER_PROBE_RATE_LIMIT_WINDOW_MS = 1_000

describe('Dynamic Instrumentation', function () {
  const t = setup({
    testApp: 'target-app/capture-disabled.js',
    dependencies: ['fastify'],
    env: { DD_TELEMETRY_HEARTBEAT_INTERVAL: '1' },
  })

  describe('probe whose capture gets permanently disabled', function () {
    this.timeout(GUARDRAIL_METRICS_FLUSH_INTERVAL_MS * 3)

    it('should stop treating the probe as snapshot producing', async function () {
      const results = []
      t.agent.on('debugger-input', ({ payload }) => results.push(...payload))

      const checkMetrics = t.agent.assertTelemetryReceived({
        fn: ({ payload }) => {
          const skipped = payload.payload.series.filter((entry) => {
            return entry.metric === 'events.skipped' && entry.tags.includes('reason:rateLimitProbe')
          })
          const eventTypes = skipped.map(({ tags }) => tags.find((tag) => tag.startsWith('event_type:')))
          assert.deepStrictEqual(eventTypes, ['event_type:log'], `Unexpected skipped events: ${inspect(skipped)}`)
          assert.strictEqual(skipped[0].points[0][1], 1)
        },
        requestType: 'generate-metrics',
        timeout: GUARDRAIL_METRICS_FLUSH_INTERVAL_MS * 2,
        resolveAtFirstSuccess: true,
        namespace: 'live_debugger',
      })

      const firstResult = new Promise((resolve) => t.agent.once('debugger-input', resolve))
      t.agent.addRemoteConfig(t.generateRemoteConfig({
        captureSnapshot: true,
        sampling: { snapshotsPerSecond: 1_000 / PER_PROBE_RATE_LIMIT_WINDOW_MS },
      }))
      await t.triggerBreakpoint()

      // The first hit trips the large object safety threshold, which disables capture for the probe
      const { payload: [{ debugger: { snapshot } }] } = await firstResult
      assert.strictEqual(snapshot.captures.lines[t.breakpoint.line].locals.huge.notCapturedReason, 'fieldCount')
      assert.match(snapshot.evaluationErrors[0].message, /exceeds the maximum number of allowed properties/)

      // Two hits within the rate limit window: the first emits a capture-less event, the second is skipped. The skip
      // must be classified as a log event now that the probe no longer produces snapshots.
      await sleep(PER_PROBE_RATE_LIMIT_WINDOW_MS + 100)
      await Promise.all([t.request(t.breakpoint.url), t.request(t.breakpoint.url)])

      await checkMetrics

      assert.strictEqual(results.length, 2, `Expected two probe results, got ${inspect(results)}`)
      assert.strictEqual(results[1].debugger.snapshot.captures, undefined, 'should not capture anything anymore')
      assert.match(results[1].debugger.snapshot.evaluationErrors[0].message, /exceeds the maximum number/)
    })
  })
})
