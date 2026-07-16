'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const { channel } = require('dc-polyfill')
const { storage } = require('../../datadog-core')

require('../../dd-trace/test/setup/core')
const BunyanPlugin = require('../src')
const Tracer = require('../../dd-trace/src/tracer')
const getConfig = require('../../dd-trace/src/config')

const logCh = channel('apm:bunyan:log')

const tracer = new Tracer(getConfig({
  enabled: true,
  logInjection: true,
  env: 'my-env',
  service: 'my-service',
  version: '1.2.3',
}))

const plugin = new BunyanPlugin({
  _tracer: tracer,
})
plugin.configure({
  logInjection: true,
  enabled: true,
})

describe('BunyanPlugin', () => {
  it('injects dd onto the record bunyan passes through _emit', () => {
    const record = { foo: 'bar', msg: 'hello' }
    logCh.publish({ message: record })
    assert.strictEqual(record.dd.service, 'my-service')
    assert.strictEqual(record.dd.version, '1.2.3')
    assert.strictEqual(record.dd.env, 'my-env')
  })

  it('preserves a caller-provided dd field', () => {
    const record = { foo: 'bar', dd: { custom: true } }
    logCh.publish({ message: record })
    assert.deepStrictEqual(record.dd, { custom: true })
  })

  it('adds trace_id and span_id when a span is active', () => {
    const span = tracer.startSpan('test')

    storage('legacy').run({ span }, () => {
      const record = { foo: 'bar' }
      logCh.publish({ message: record })
      assert.strictEqual(record.dd.trace_id, span.context().toTraceId(true))
      assert.strictEqual(record.dd.span_id, span.context().toSpanId())
    })
  })

  it('does not mutate a caller-set dd even when a span is active', () => {
    const span = tracer.startSpan('test')

    storage('legacy').run({ span }, () => {
      const record = { foo: 'bar', dd: { custom: true } }
      logCh.publish({ message: record })
      assert.deepStrictEqual(record.dd, { custom: true })
    })
  })

  it('does not run on non-object messages', () => {
    const payload = { message: 'just a string' }
    logCh.publish(payload)
    assert.strictEqual(payload.message, 'just a string')
  })

  it('leaves the record untouched when the propagator emits no dd', () => {
    const originalInject = tracer.inject
    tracer.inject = () => {}
    try {
      const record = { foo: 'bar' }
      logCh.publish({ message: record })
      assert.strictEqual(record.dd, undefined)
    } finally {
      tracer.inject = originalInject
    }
  })
})
