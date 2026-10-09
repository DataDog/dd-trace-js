'use strict'

const assert = require('node:assert/strict')
const { writeFileSync } = require('fs')
const os = require('os')
const { join } = require('path')

const { isACFActive } = require('../../packages/datadog-core/src/storage')
const { setup, setupAssertionListeners, testBasicInputWithoutRC } = require('./utils')

describe('Dynamic Instrumentation', function () {
  describe('probe file', function () {
    const probeFile = join(os.tmpdir(), 'probes.json')
    const t = setup({
      testApp: 'target-app/basic.js',
      env: { DD_DYNAMIC_INSTRUMENTATION_PROBE_FILE: probeFile },
      dependencies: ['fastify'],
    })
    const probe = t.generateProbeConfig()
    writeFileSync(probeFile, JSON.stringify([probe]))

    it('should install probes from a probe file', testBasicInputWithoutRC.bind(null, t, probe))
  })

  describe('probe file with OTLP trace export', function () {
    const probeFile = join(os.tmpdir(), 'otlp-probes.json')
    const t = setup({
      testApp: 'target-app/basic.js',
      env: (agent) => ({
        DD_DYNAMIC_INSTRUMENTATION_PROBE_FILE: probeFile,
        DD_TRACE_OTEL_SEMANTICS_ENABLED: 'true',
        ...(!isACFActive && { TRIGGER_MISSING_ASYNC_RESOURCE: 'true' }),
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${agent.port}/v1/traces`,
      }),
      dependencies: ['fastify'],
    })
    const probe = t.generateProbeConfig({ captureSnapshot: true })
    writeFileSync(probeFile, JSON.stringify([probe]))

    it('should send debugger snapshots while traces use OTLP semantics', function (done) {
      t.triggerBreakpoint()
      setupAssertionListeners(t, done, probe, {
        event: 'otlp-traces',
        validateSpan: (span) => assert.strictEqual(span.name, 'GET /foo/:name'),
      })
    })
  })
})
