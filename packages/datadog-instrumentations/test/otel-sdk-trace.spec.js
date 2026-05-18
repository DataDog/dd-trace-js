'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

describe('otel-sdk-trace', () => {
  /**
   * Re-load `otel-sdk-trace.js` with the supplied env values stubbed in via
   * `getValueFromEnvSources` and report what `addHook` saw.
   *
   * @param {{ ddTraceOtelEnabled?: string, otelSdkDisabled?: string }} env
   * @param {{ TracerProvider?: unknown }} [tracerStub]
   * @returns {{ addHook: sinon.SinonSpy, wrap: sinon.SinonSpy }}
   */
  function loadWithEnv (env, tracerStub = {}) {
    const addHook = sinon.spy()
    const wrap = sinon.spy()
    const values = {
      DD_TRACE_OTEL_ENABLED: env.ddTraceOtelEnabled,
      OTEL_SDK_DISABLED: env.otelSdkDisabled,
    }
    proxyquire('../src/otel-sdk-trace', {
      '../../datadog-shimmer': { wrap },
      '../../dd-trace': tracerStub,
      '../../dd-trace/src/config/helper': {
        getValueFromEnvSources: (name) => values[name],
      },
      './helpers/instrument': { addHook },
    })
    return { addHook, wrap }
  }

  describe('gate precedence', () => {
    it('disables when DD_TRACE_OTEL_ENABLED is the explicit opt-out', () => {
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: 'false' }).addHook.called, false)
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: '0' }).addHook.called, false)
    })

    it('keeps DD opt-out winning even when OTEL_SDK_DISABLED=false opts in', () => {
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: 'false', otelSdkDisabled: 'false' }).addHook.called, false)
    })

    it('disables when OTEL_SDK_DISABLED is the explicit opt-out', () => {
      assert.equal(loadWithEnv({ otelSdkDisabled: 'true' }).addHook.called, false)
      assert.equal(loadWithEnv({ otelSdkDisabled: '1' }).addHook.called, false)
    })

    it('keeps OTel opt-out winning even when DD_TRACE_OTEL_ENABLED=true opts in', () => {
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: 'true', otelSdkDisabled: 'true' }).addHook.called, false)
    })

    it('enables when DD_TRACE_OTEL_ENABLED is the explicit opt-in', () => {
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: 'true' }).addHook.called, true)
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: '1' }).addHook.called, true)
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: 'true', otelSdkDisabled: 'false' }).addHook.called, true)
    })

    it('enables when OTEL_SDK_DISABLED=false is the OTel positive opt-in', () => {
      assert.equal(loadWithEnv({ otelSdkDisabled: 'false' }).addHook.called, true)
      assert.equal(loadWithEnv({ otelSdkDisabled: '0' }).addHook.called, true)
    })

    it('stays disabled by default when neither env var is set', () => {
      assert.equal(loadWithEnv({}).addHook.called, false)
    })

    it('stays disabled for unrecognized values on either side', () => {
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: 'maybe', otelSdkDisabled: 'sure' }).addHook.called, false)
      assert.equal(loadWithEnv({ ddTraceOtelEnabled: '' }).addHook.called, false)
    })
  })

  describe('hook registration', () => {
    it('wraps NodeTracerProvider with the dd-trace TracerProvider', () => {
      const tracerProvider = function FakeTracerProvider () {}
      const { addHook, wrap } = loadWithEnv({ ddTraceOtelEnabled: 'true' }, { TracerProvider: tracerProvider })

      sinon.assert.calledOnce(addHook)
      const [hookOptions, transform] = addHook.firstCall.args
      assert.deepStrictEqual(hookOptions, {
        name: '@opentelemetry/sdk-trace-node',
        file: 'build/src/NodeTracerProvider.js',
        versions: ['*'],
      })

      const mod = { NodeTracerProvider: function OriginalProvider () {} }
      assert.equal(transform(mod), mod)

      sinon.assert.calledOnceWithExactly(wrap, mod, 'NodeTracerProvider', sinon.match.func)
      assert.equal(wrap.firstCall.args[2](), tracerProvider)
    })
  })
})
