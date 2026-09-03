'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { setup } = require('./utils')

// The guardrail counters are converted into telemetry metrics every 10 seconds, which are then sent on the next
// telemetry heartbeat
const GUARDRAIL_METRICS_FLUSH_INTERVAL_MS = 10_000
const QUEUE_MAX_BYTES = 64 * 1024

describe('Dynamic Instrumentation', function () {
  const t = setup({
    testApp: 'target-app/basic.js',
    dependencies: ['fastify'],
    env: {
      DD_DYNAMIC_INSTRUMENTATION_QUEUE_MAX_BYTES: String(QUEUE_MAX_BYTES),
      DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
    },
    agentOptions: { stallDebuggerIntake: true },
  })

  describe('bounded upload queue', function () {
    this.timeout(GUARDRAIL_METRICS_FLUSH_INTERVAL_MS * 3)

    it('should drop probe results instead of queueing them without bound when the intake stalls', async function () {
      const rcConfig = t.generateRemoteConfig({ captureSnapshot: true, sampling: { snapshotsPerSecond: 1000 } })
      const uploadSizes = []

      t.agent.on('debugger-input-stalled', ({ headers }) => {
        uploadSizes.push(Number(headers['content-length']))
      })

      const installed = new Promise((/** @type {(value?: void) => void} */ resolve) => {
        t.agent.on('debugger-diagnostics', ({ payload }) => {
          if (payload.some(({ debugger: { diagnostics } }) => diagnostics.status === 'INSTALLED')) resolve()
        })
      })

      const checkMetrics = t.agent.assertTelemetryReceived({
        fn: ({ payload }) => {
          const { series } = payload.payload
          const dropped = series.find((entry) => {
            return entry.metric === 'events.dropped' &&
              entry.tags.includes('event_type:snapshot') &&
              entry.tags.includes('reason:queueFull')
          })
          assert.ok(dropped, `Expected events.dropped metric in ${inspect(series)}`)
          assert.strictEqual(dropped.type, 'count')
          assert.ok(dropped.points[0][1] >= 1, `Expected ${dropped.points[0][1]} >= 1`)
        },
        requestType: 'generate-metrics',
        timeout: GUARDRAIL_METRICS_FLUSH_INTERVAL_MS * 2,
        resolveAtFirstSuccess: true,
        namespace: 'live_debugger',
      })

      t.agent.addRemoteConfig(rcConfig)
      await installed

      // Each snapshot of the request handler is a few KB. The global snapshot rate limit caps snapshots at 25 per
      // second, so spread the requests over a few seconds to produce far more snapshot bytes than the queue can hold
      for (let round = 0; round < 3; round++) {
        await Promise.all(Array.from({ length: 30 }, () => t.request(t.breakpoint.url)))
        await new Promise((resolve) => setTimeout(resolve, 1100))
      }

      await checkMetrics

      assert.ok(uploadSizes.length >= 1, `Expected at least one upload attempt, got ${uploadSizes.length}`)
      for (const size of uploadSizes) {
        assert.ok(size <= QUEUE_MAX_BYTES, `Expected upload of ${size} bytes to be within the queue bound`)
      }
    })
  })
})
