'use strict'

const assert = require('node:assert/strict')

const { SHARED_TELEMETRY_FLUSH_INTERVAL_MS } = require('../../packages/dd-trace/src/debugger/constants')
const { DDSketch } = require('../../vendor/dist/@datadog/sketches-js')
const { setup } = require('./utils')

describe('Dynamic Instrumentation/Live Debugger pause duration telemetry', function () {
  // Durations are aggregated in shared memory and only drained into telemetry at the flush interval
  this.timeout(SHARED_TELEMETRY_FLUSH_INTERVAL_MS * 3)

  const t = setup({
    testApp: 'target-app/basic.js',
    dependencies: ['fastify'],
    env: {
      DD_TRACE_DEBUG: 'false',
      DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
    },
  })

  for (const captureSnapshot of [false, true]) {
    it(`should send a pause duration sketch for a ${captureSnapshot ? 'snapshot' : 'log'} probe`, async function () {
      const probe = t.generateRemoteConfig({ captureSnapshot })
      const installed = t.waitForProbeStatus([probe.config.id], 'INSTALLED')
      const received = t.agent.assertTelemetryReceived({
        requestType: 'sketches',
        namespace: 'live_debugger',
        timeout: SHARED_TELEMETRY_FLUSH_INTERVAL_MS * 2,
        resolveAtFirstSuccess: true,
        fn: ({ payload }) => {
          const [series] = payload.payload.series
          assert.strictEqual(series.metric, 'execution.pause.duration')
          assert.strictEqual(series.common, true)
          assert.deepStrictEqual(series.tags, [])
          const sketch = DDSketch.fromProto(Buffer.from(series.sketch_b64, 'base64'))
          assert.strictEqual(sketch.count, 1)
          const durationMs = sketch.getValueAtQuantile(0.5)
          assert.ok(durationMs > 0)
          assert.ok(Number.isFinite(durationMs))
        },
      })

      t.agent.addRemoteConfig(probe)
      await Promise.all([
        received,
        installed.then(() => t.request(t.breakpoint.url)),
      ])
    })
  }
})
