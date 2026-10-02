'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const {
  DEFAULT_QUEUE_MAX_BYTES,
  SHARED_TELEMETRY_FLUSH_INTERVAL_MS,
} = require('../../packages/dd-trace/src/debugger/constants')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({
    testApp: 'target-app/bounded-queue.js',
    dependencies: ['fastify'],
    env: {
      DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
    },
    agentOptions: { stallDebuggerIntake: true },
  })

  describe('bounded upload queue', function () {
    this.timeout(SHARED_TELEMETRY_FLUSH_INTERVAL_MS * 3)

    it('should drop probe results instead of queueing them without bound when the intake stalls', async function () {
      const rcConfig = t.generateRemoteConfig({
        captureSnapshot: true,
        capture: { maxLength: 512 * 1024 },
        sampling: { snapshotsPerSecond: 1000 },
      })
      const uploadSizes = new Map()

      t.agent.on('debugger-input-stalled', ({ headers, payload }) => {
        const snapshotIds = payload.map(({ debugger: { snapshot } }) => snapshot.id).join(',')
        uploadSizes.set(snapshotIds, Number(headers['content-length']))
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
        timeout: SHARED_TELEMETRY_FLUSH_INTERVAL_MS * 2,
        resolveAtFirstSuccess: true,
        namespace: 'live_debugger',
      })

      t.agent.addRemoteConfig(rcConfig)
      await installed

      // The first 25 snapshots allowed by the global rate limit contain a 512 KiB string, producing more than 10 MiB
      await Promise.all(Array.from({ length: 30 }, () => t.request(t.breakpoint.url)))

      await checkMetrics

      assert.ok(uploadSizes.size >= 1, `Expected at least one unique upload, got ${uploadSizes.size}`)
      const uploadedBytes = [...uploadSizes.values()].reduce((total, size) => total + size, 0)
      assert.ok(
        uploadedBytes <= DEFAULT_QUEUE_MAX_BYTES,
        `Expected uploads totaling ${uploadedBytes} bytes to be within the ${DEFAULT_QUEUE_MAX_BYTES} byte queue bound`
      )
    })
  })
})
