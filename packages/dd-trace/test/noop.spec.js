'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')

const { describe, it, beforeEach } = require('mocha')

require('./setup/core')
const Span = require('../src/noop/span')

describe('NoopTracer', () => {
  let NoopTracer
  let tracer

  for (const [name, setup] of [
    ['a Jest worker', 'globalThis.jest = {}'],
    ['DD_TRACE_ENABLED=false', "process.env.DD_TRACE_ENABLED = 'false'"],
    ['OTEL_TRACES_EXPORTER=none', "process.env.OTEL_TRACES_EXPORTER = 'none'"],
  ]) {
    it(`should not subscribe to identity updates with ${name}`, () => {
      const script = `
        const assert = require('node:assert/strict')
        const { channel } = require('dc-polyfill')
        delete process.env.DD_TRACE_ENABLED
        delete process.env.DD_AGENTLESS_ENABLED
        delete process.env._DD_APM_TRACING_AGENTLESS_ENABLED
        delete process.env.OTEL_TRACES_EXPORTER
        ${setup}
        const identity = channel('datadog:identity:update')
        assert.strictEqual(identity.hasSubscribers, false)
        const tracer = require(${JSON.stringify(require.resolve('../../..'))})
        assert.strictEqual(identity.hasSubscribers, false)
        tracer.init()
        tracer.trace('test', span => {
          assert.match(span.context().toTraceId(), /^\\d+$/)
          span.finish()
        })
        assert.strictEqual(identity.hasSubscribers, false)
      `
      const result = spawnSync(process.execPath, ['--eval', script], {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, NODE_OPTIONS: '' },
      })

      assert.ifError(result.error)
      assert.strictEqual(result.status, 0, result.stderr)
    })
  }

  beforeEach(() => {
    NoopTracer = require('../src/noop/tracer')
    tracer = new NoopTracer()
  })

  describe('trace', () => {
    it('should provide a span and done function', () => {
      tracer.trace('test', {}, (span, done) => {
        assert.ok(span instanceof Span)
        assert.strictEqual(typeof done, 'function')
        done()
      })
    })

    it('should return the return value of the function', () => {
      const result = tracer.trace('test', {}, () => 'test')

      assert.strictEqual(result, 'test')
    })

    it('should provide recordException as a no-op', () => {
      tracer.trace('test', {}, span => {
        assert.strictEqual(typeof span.recordException, 'function')
        span.recordException(new Error('test'))
      })
    })
  })

  describe('wrap', () => {
    it('should return the function', () => {
      const fn = () => {}

      assert.strictEqual(tracer.wrap('test', {}, fn), fn)
    })
  })

  describe('startSpan', () => {
    it('should return a span with a valid context', () => {
      const span = tracer.startSpan()

      assert.strictEqual(typeof span.context().toTraceId, 'function')
      assert.match(span.context().toTraceId(), /^\d+$/)
      assert.strictEqual(typeof span.context().toSpanId, 'function')
      assert.match(span.context().toSpanId(), /^\d+$/)
    })
  })
})
