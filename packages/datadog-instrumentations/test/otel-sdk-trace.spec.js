'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { resolve } = require('node:path')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

describe('otel-sdk-trace', () => {
  /**
   * Re-load `otel-sdk-trace.js` with real configuration parsing for the supplied
   * environment values and report whether it instrumented.
   *
   * The real `datadog-shimmer` and `addHook` transforms run so the load reflects
   * production behavior; `capturedTransforms` collects the transforms so a test can
   * apply them to a fake module and assert the observable swap.
   *
   * @param {{ ddTraceOtelEnabled?: boolean, otelSdkDisabled?: boolean }} env
   * @param {{ TracerProvider?: unknown }} [tracerStub]
   * @returns {{ instrumented: boolean, capturedTransforms: Array<(mod: object) => object> }}
   */
  function loadWithEnv (env, tracerStub = {}) {
    const originalEnv = process.env
    process.env = { ...originalEnv }
    for (const [name, value] of Object.entries({
      DD_TRACE_OTEL_ENABLED: env.ddTraceOtelEnabled,
      OTEL_SDK_DISABLED: env.otelSdkDisabled,
    })) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = String(value)
    }
    try {
      const helper = proxyquire('../../dd-trace/src/config/helper', {
        '../serverless': { IS_SERVERLESS: true },
      })
      const capturedTransforms = []
      proxyquire('../src/otel-sdk-trace', {
        '../../dd-trace': tracerStub,
        '../../dd-trace/src/config/helper': helper,
        './helpers/instrument': {
          addHook: (_options, transform) => capturedTransforms.push(transform),
        },
      })
      return { instrumented: capturedTransforms.length > 0, capturedTransforms }
    } finally {
      process.env = originalEnv
    }
  }

  describe('gate precedence', () => {
    it('disables when DD_TRACE_OTEL_ENABLED is the explicit opt-out', () => {
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: false }).instrumented, false)
    })

    it('keeps DD opt-out winning even when OTEL_SDK_DISABLED=false opts in', () => {
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: false, otelSdkDisabled: false }).instrumented, false)
    })

    it('disables when OTEL_SDK_DISABLED is the explicit opt-out', () => {
      assert.equal(loadWithEnv({ otelSdkDisabled: true }).instrumented, false)
    })

    it('keeps OTel opt-out winning even when DD_TRACE_OTEL_ENABLED=true opts in', () => {
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: true, otelSdkDisabled: true }).instrumented, false)
    })

    it('enables when DD_TRACE_OTEL_ENABLED is the explicit opt-in', () => {
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: true }).instrumented, true)
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: true, otelSdkDisabled: false }).instrumented, true)
    })

    it('enables when OTEL_SDK_DISABLED=false is the OTel positive opt-in', () => {
      assert.equal(loadWithEnv({ otelSdkDisabled: false }).instrumented, true)
    })

    it('stays disabled by default when neither option is set', () => {
      assert.equal(loadWithEnv({}).instrumented, false)
    })

    it('treats a value the helper rejected (undefined) as unset', () => {
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: undefined, otelSdkDisabled: undefined }).instrumented, false)
    })
  })

  it('reports bridge enablement without loading SDK instrumentation', () => {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DD_|_DD_|OTEL_)/.test(name)))
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict')
      require('./').init({
        appsec: false, iast: false, plugins: false, runtimeMetrics: false,
        remoteConfig: { enabled: false }, startupLogs: false
      })
      const { tracerInfo } = require('./packages/dd-trace/src/startup-log')
      assert.equal(JSON.parse(String(tracerInfo())).OTEL_ENABLED, true)
      const hookPath = require.resolve('./packages/datadog-instrumentations/src/otel-sdk-trace')
      assert.equal(require.cache[hookPath], undefined)
      process.exit(0)
    `], {
      cwd: resolve(__dirname, '../../..'),
      env: { ...inherited, OTEL_SDK_DISABLED: 'false' },
    })
  })

  describe('provider replacement', () => {
    // Assert the observable swap through the real shimmer rather than the addHook metadata: whatever
    // SDK provider export the transforms touch ends up as the dd-trace TracerProvider. This survives
    // renames of the hooked file/version wiring and covers both the sdk-trace-node NodeTracerProvider
    // and (for sdk-node >= 0.220.0) the sdk-trace TracerProvider export the newer SDK builds from.
    it('replaces each SDK provider export with the dd-trace TracerProvider', () => {
      class DatadogTracerProvider {}
      const tracerStub = { TracerProvider: DatadogTracerProvider }
      const { capturedTransforms } = loadWithEnv({ ddTraceOtelEnabled: true }, tracerStub)

      assert.ok(capturedTransforms.length > 0, 'the instrumentation registered no hooks')

      const mod = { NodeTracerProvider: class {}, TracerProvider: class {} }
      for (const transform of capturedTransforms) {
        assert.equal(transform(mod), mod)
      }

      assert.equal(mod.NodeTracerProvider, DatadogTracerProvider)
      assert.equal(mod.TracerProvider, DatadogTracerProvider)
    })
  })
})
