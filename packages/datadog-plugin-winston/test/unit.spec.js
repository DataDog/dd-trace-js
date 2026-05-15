'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const { channel } = require('dc-polyfill')
const { storage } = require('../../datadog-core')

require('../../dd-trace/test/setup/core')
const WinstonPlugin = require('../src')
const Tracer = require('../../dd-trace/src/tracer')
const getConfig = require('../../dd-trace/src/config')

const logCh = channel('apm:winston:log')

const tracer = new Tracer(getConfig({
  enabled: true,
  logInjection: true,
  env: 'my-env',
  service: 'my-service',
  version: '1.2.3',
}))

const plugin = new WinstonPlugin({
  _tracer: tracer,
})
plugin.configure({
  logInjection: true,
  enabled: true,
})

describe('WinstonPlugin', () => {
  it('injects dd onto the info object winston passes through write', () => {
    const info = { level: 'info', message: 'hello' }
    logCh.publish({ message: info })
    assert.strictEqual(info.dd.service, 'my-service')
    assert.strictEqual(info.dd.version, '1.2.3')
    assert.strictEqual(info.dd.env, 'my-env')
  })

  it('preserves a caller-provided dd field', () => {
    const info = { level: 'info', message: 'hello', dd: { custom: true } }
    logCh.publish({ message: info })
    assert.deepStrictEqual(info.dd, { custom: true })
  })

  it('adds trace_id and span_id when a span is active', () => {
    const span = tracer.startSpan('test')

    storage('legacy').run({ span }, () => {
      const info = { level: 'info', message: 'hello' }
      logCh.publish({ message: info })
      assert.strictEqual(info.dd.trace_id, span.context().toTraceId(true))
      assert.strictEqual(info.dd.span_id, span.context().toSpanId())
    })
  })

  it('does not run on non-object messages', () => {
    const payload = { message: null }
    logCh.publish(payload)
    assert.strictEqual(payload.message, null)
  })
})
