'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
const { inspect } = require('node:util')

const { METRICS_FLUSH_INTERVAL_MS } = require('../../packages/dd-trace/src/debugger/constants')
const { MAX_SNAPSHOTS_PER_SECOND_PER_PROBE } = require('../../packages/dd-trace/src/debugger/devtools_client/defaults')
const { setup } = require('./utils')

// The probe is limited to one event per second, so two hits in quick succession skip the second one
const PER_PROBE_RATE_LIMIT_WINDOW_MS = 1_000
// A snapshot probe without an explicit sampling rate gets this much time between events
const DEFAULT_SNAPSHOT_RATE_LIMIT_WINDOW_MS = 1_000 / MAX_SNAPSHOTS_PER_SECOND_PER_PROBE

describe('Dynamic Instrumentation', function () {
  const t = setup({
    testApp: 'target-app/capture-disabled.js',
    dependencies: ['fastify'],
    env: { DD_TELEMETRY_HEARTBEAT_INTERVAL: '1' },
  })

  describe('probe whose capture gets permanently disabled', function () {
    this.timeout(METRICS_FLUSH_INTERVAL_MS * 3)

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
        timeout: METRICS_FLUSH_INTERVAL_MS * 2,
        resolveAtFirstSuccess: true,
        namespace: 'debugger',
      })

      const firstResult = once(t.agent, 'debugger-input')
      t.agent.addRemoteConfig(t.generateRemoteConfig({
        captureSnapshot: true,
        sampling: { snapshotsPerSecond: 1_000 / PER_PROBE_RATE_LIMIT_WINDOW_MS },
      }))
      await t.triggerBreakpoint()

      // The first hit trips the large object safety threshold, which disables capture for the probe
      const [{ payload: [{ debugger: { snapshot } }] }] = await firstResult
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

    it('should switch the probe to the default sampling rate of probes without captures', async function () {
      const results = []
      /** @type {() => void} */
      let resolveResults
      const allResults = new Promise((resolve) => { resolveResults = resolve })
      t.agent.on('debugger-input', ({ payload }) => {
        results.push(...payload)
        if (results.length === 3) resolveResults()
      })

      const rcConfig = t.generateRemoteConfig({ captureSnapshot: true })
      // The probe config helper always sets a sampling rate, but this is about the rate a probe gets without one
      delete rcConfig.config.sampling
      t.agent.addRemoteConfig(rcConfig)
      // The first hit trips the large object safety threshold, which disables capture for the probe
      await t.triggerBreakpoint()

      // Two hits in quick succession: the default snapshot rate would skip the second one, while the default rate of
      // probes without captures lets both through. Waiting out the snapshot rate window first leaves the sampling
      // rate the probe was refreshed with as the only thing deciding.
      await sleep(DEFAULT_SNAPSHOT_RATE_LIMIT_WINDOW_MS + 100)
      await Promise.all([t.request(t.breakpoint.url), t.request(t.breakpoint.url)])

      await allResults

      assert.strictEqual(results[0].debugger.snapshot.captures.lines[t.breakpoint.line].locals.huge.notCapturedReason,
        'fieldCount')
      for (const { debugger: { snapshot } } of results.slice(1)) {
        assert.strictEqual(snapshot.captures, undefined, 'should not capture anything anymore')
        assert.match(snapshot.evaluationErrors[0].message, /exceeds the maximum number/)
      }
    })
  })
})
