'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

describe('otel-sdk-trace', () => {
  /**
   * Re-load `otel-sdk-trace.js` with the supplied config values stubbed in via
   * `getValueFromEnvSources` and report whether it instrumented. `getValueFromEnvSources`
   * already parses these registered boolean options, so the gate sees `true`,
   * `false`, or `undefined` — never a raw string. Parsing tolerance ('1', 'maybe',
   * '') is exercised in the config helper's own spec.
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
    const values = {
      DD_TRACE_OTEL_ENABLED: env.ddTraceOtelEnabled,
      OTEL_SDK_DISABLED: env.otelSdkDisabled,
    }
    const capturedTransforms = []
    proxyquire('../src/otel-sdk-trace', {
      '../../dd-trace': tracerStub,
      '../../dd-trace/src/config/helper': {
        getValueFromEnvSources: (name) => values[name],
      },
      './helpers/instrument': {
        addHook: (_options, transform) => capturedTransforms.push(transform),
      },
    })
    return { instrumented: capturedTransforms.length > 0, capturedTransforms }
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
