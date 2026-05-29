'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const { channel } = require('dc-polyfill')
const { storage } = require('../../datadog-core')

require('../../dd-trace/test/setup/core')
const PinoPlugin = require('../src')
const Tracer = require('../../dd-trace/src/tracer')
const getConfig = require('../../dd-trace/src/config')

const jsonCh = channel('apm:pino:log:json')
const messageCh = channel('apm:pino:log')

const tracer = new Tracer(getConfig({
  enabled: true,
  logInjection: true,
  env: 'my-env',
  service: 'my-service',
  version: '1.2.3',
}))

const plugin = new PinoPlugin({
  _tracer: tracer,
})
plugin.configure({
  logInjection: true,
  enabled: true,
})

describe('PinoPlugin', () => {
  it('splices trace correlation into pino JSON output', () => {
    const data = { line: '{"level":30,"msg":"hello"}' }
    jsonCh.publish(data)
    const parsed = JSON.parse(data.line)
    assert.strictEqual(parsed.level, 30)
    assert.strictEqual(parsed.msg, 'hello')
    assert.strictEqual(parsed.dd.service, 'my-service')
    assert.strictEqual(parsed.dd.version, '1.2.3')
    assert.strictEqual(parsed.dd.env, 'my-env')
  })

  it('handles a pino JSON line that ends with a newline', () => {
    const data = { line: '{"level":30,"msg":"hi"}\n' }
    jsonCh.publish(data)
    // The splice happens before the closing `}`; the trailing newline stays.
    assert.match(data.line, /\}\n$/)
    const parsed = JSON.parse(data.line)
    assert.strictEqual(parsed.dd.service, 'my-service')
  })

  it('produces valid JSON when the original line is empty `{}`', () => {
    const data = { line: '{}' }
    jsonCh.publish(data)
    const parsed = JSON.parse(data.line)
    assert.strictEqual(parsed.dd.service, 'my-service')
  })

  it('includes trace_id and span_id when a span is active', () => {
    const span = tracer.startSpan('test')

    storage('legacy').run({ span }, () => {
      const data = { line: '{"msg":"x"}' }
      jsonCh.publish(data)
      const parsed = JSON.parse(data.line)
      assert.strictEqual(parsed.dd.trace_id, span.context().toTraceId(true))
      assert.strictEqual(parsed.dd.span_id, span.context().toSpanId())
    })
  })

  it('does not splice when the line is unrecognised', () => {
    const data = { line: 'malformed' }
    jsonCh.publish(data)
    assert.strictEqual(data.line, 'malformed')
  })

  it('leaves the line untouched when the propagator emits no dd', () => {
    const originalInject = tracer.inject
    tracer.inject = () => {}
    try {
      const data = { line: '{"level":30,"msg":"hello"}' }
      jsonCh.publish(data)
      assert.strictEqual(data.line, '{"level":30,"msg":"hello"}')
    } finally {
      tracer.inject = originalInject
    }
  })

  describe('apm:pino:log (pino-pretty path)', () => {
    it('exposes dd as a virtual field on the message proxy', () => {
      const original = { level: 30, msg: 'hello' }
      const data = { message: original }
      messageCh.publish(data)
      assert.notStrictEqual(data.message, original)
      assert.deepStrictEqual(data.message.dd, {
        service: 'my-service',
        version: '1.2.3',
        env: 'my-env',
      })
      assert.strictEqual(data.message.msg, 'hello')
      assert.strictEqual(Object.keys(data.message).includes('dd'), true)
    })

    it('includes trace_id and span_id when a span is active', () => {
      const span = tracer.startSpan('test')
      storage('legacy').run({ span }, () => {
        const data = { message: { msg: 'hello' } }
        messageCh.publish(data)
        assert.strictEqual(data.message.dd.trace_id, span.context().toTraceId(true))
        assert.strictEqual(data.message.dd.span_id, span.context().toSpanId())
      })
    })

    it('keeps the caller-set dd visible without overriding it', () => {
      const original = { msg: 'hello', dd: { trace_id: 'user-supplied' } }
      const data = { message: original }
      messageCh.publish(data)
      assert.strictEqual(data.message.dd.trace_id, 'user-supplied')
    })

    it('leaves the message untouched when the propagator emits no dd', () => {
      const originalInject = tracer.inject
      tracer.inject = () => {}
      try {
        const original = { msg: 'hello' }
        const data = { message: original }
        messageCh.publish(data)
        assert.strictEqual(data.message, original)
      } finally {
        tracer.inject = originalInject
      }
    })
  })
})
