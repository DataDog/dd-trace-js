'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const { describe, it } = require('mocha')

require('./setup/core')

const INDEX_PATH = path.resolve(__dirname, '..', 'src', 'index.js')

function resolveProxyClass (env) {
  const out = execFileSync(
    process.execPath,
    ['-e', `process.stdout.write(require(${JSON.stringify(INDEX_PATH)}).name)`],
    { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }
  )
  return out
}

describe('packages/dd-trace/src/index proxy selection', () => {
  it('returns the real Tracer by default', () => {
    assert.equal(resolveProxyClass({}), 'Tracer')
  })

  it('returns NoopProxy when DD_TRACE_ENABLED=false', () => {
    assert.equal(resolveProxyClass({ DD_TRACE_ENABLED: 'false' }), 'NoopProxy')
  })

  it('returns NoopProxy when DD_TRACING_ENABLED=0 (alias)', () => {
    assert.equal(resolveProxyClass({ DD_TRACING_ENABLED: '0' }), 'NoopProxy')
  })

  it('returns NoopProxy when OTEL_TRACES_EXPORTER=none', () => {
    assert.equal(resolveProxyClass({ OTEL_TRACES_EXPORTER: 'none' }), 'NoopProxy')
  })

  describe('escape hatches that keep the real proxy when tracing is disabled', () => {
    for (const flag of [
      'DD_DYNAMIC_INSTRUMENTATION_ENABLED',
      'DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED',
    ]) {
      it(`keeps the real Tracer when ${flag}=true`, () => {
        assert.equal(resolveProxyClass({ DD_TRACE_ENABLED: 'false', [flag]: 'true' }), 'Tracer')
      })
    }

    for (const value of ['true', '1', 'auto']) {
      it(`keeps the real Tracer when DD_PROFILING_ENABLED=${value}`, () => {
        assert.equal(
          resolveProxyClass({ DD_TRACE_ENABLED: 'false', DD_PROFILING_ENABLED: value }),
          'Tracer'
        )
      })
    }

    it('still returns NoopProxy when DD_PROFILING_ENABLED=false', () => {
      assert.equal(
        resolveProxyClass({ DD_TRACE_ENABLED: 'false', DD_PROFILING_ENABLED: 'false' }),
        'NoopProxy'
      )
    })

    it('keeps the real Tracer when DD_TRACING_ENABLED=0 alias is paired with DD_PROFILING_ENABLED=1', () => {
      assert.equal(
        resolveProxyClass({ DD_TRACING_ENABLED: '0', DD_PROFILING_ENABLED: '1' }),
        'Tracer'
      )
    })
  })
})
