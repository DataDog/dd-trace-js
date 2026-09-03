'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { setup } = require('./utils')

// The guardrail counters are converted into telemetry metrics every 10 seconds, which are then sent on the next
// telemetry heartbeat
const GUARDRAIL_METRICS_FLUSH_INTERVAL_MS = 10_000

// `^(a+)+$` backtracks exponentially against a non-matching input, so a few dozen characters blow past the budget.
// Regular expressions can't be interrupted, so the budget is enforced by reporting and throttling after the fact.
const REDOS_INPUT = 'a'.repeat(24) + '!'
const REDOS_CONDITION = {
  dsl: 'request.params.name matches "^(a+)+$"',
  json: { matches: [{ getmember: [{ getmember: [{ ref: 'request' }, 'params'] }, 'name'] }, '^(a+)+$'] },
}

describe('Dynamic Instrumentation', function () {
  const t = setup({
    testApp: 'target-app/basic.js',
    dependencies: ['fastify'],
    env: { DD_TELEMETRY_HEARTBEAT_INTERVAL: '1' },
  })

  describe('evaluation time budget', function () {
    this.timeout(GUARDRAIL_METRICS_FLUSH_INTERVAL_MS * 3)

    it('should report a condition that exceeds its time budget once and skip the probe afterwards', async function () {
      const rcConfig = t.generateRemoteConfig({ captureSnapshot: true, when: REDOS_CONDITION })
      const url = `/foo/${REDOS_INPUT}`
      const results = []

      t.agent.on('debugger-input', ({ payload }) => results.push(...payload))

      const installed = new Promise((/** @type {(value?: void) => void} */ resolve) => {
        t.agent.on('debugger-diagnostics', ({ payload }) => {
          if (payload.some(({ debugger: { diagnostics } }) => diagnostics.status === 'INSTALLED')) resolve()
        })
      })

      const checkMetrics = t.agent.assertTelemetryReceived({
        fn: ({ payload }) => {
          const { series } = payload.payload
          const skipped = series.find((entry) => {
            return entry.metric === 'events.skipped' &&
              entry.tags.includes('event_type:snapshot') &&
              entry.tags.includes('reason:evaluationTimeout')
          })
          assert.ok(skipped, `Expected events.skipped metric in ${inspect(series)}`)
          assert.strictEqual(skipped.type, 'count')
          assert.strictEqual(skipped.points[0][1], 2)
        },
        requestType: 'generate-metrics',
        timeout: GUARDRAIL_METRICS_FLUSH_INTERVAL_MS * 2,
        resolveAtFirstSuccess: true,
        namespace: 'live_debugger',
      })

      t.agent.addRemoteConfig(rcConfig)
      await installed

      // The first hit pays for the slow evaluation and reports it
      const slowStart = Date.now()
      await t.request(url)
      const slowDuration = Date.now() - slowStart

      // The following hits are skipped at probe entry without evaluating the condition
      const fastStart = Date.now()
      await t.request(url)
      await t.request(url)
      const fastDuration = Date.now() - fastStart

      assert.ok(
        fastDuration < slowDuration,
        `Expected throttled hits (${fastDuration}ms for two) to be faster than the first hit (${slowDuration}ms)`
      )

      await checkMetrics

      assert.strictEqual(results.length, 1, `Expected exactly one probe result, got ${inspect(results)}`)
      const { message, debugger: { snapshot } } = results[0]
      assert.match(message, /^Condition evaluation exceeded its time budget of 10ms \(took \d+\.\dms\)$/)
      assert.strictEqual(snapshot.evaluationErrors.length, 1)
      assert.strictEqual(snapshot.evaluationErrors[0].expr, REDOS_CONDITION.dsl)
      assert.strictEqual(snapshot.evaluationErrors[0].message, message)
      assert.strictEqual(snapshot.captures, undefined, 'should not capture anything for a timed out condition')
    })
  })
})
