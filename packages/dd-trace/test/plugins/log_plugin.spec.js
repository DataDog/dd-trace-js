'use strict'

const assert = require('node:assert/strict')
const { assertObjectContains } = require('../../../../integration-tests/helpers')

const { describe, it } = require('tap').mocha
const { channel } = require('dc-polyfill')

require('../setup/core')

const LogPlugin = require('../../src/plugins/log_plugin')
const Tracer = require('../../src/tracer')
const getConfig = require('../../src/config')

const testLogChannel = channel('apm:test:log')

class TestLog extends LogPlugin {
  static id = 'test'
}

const config = {
  env: 'my-env',
  service: 'my-service',
  version: '1.2.3'
}

const tracer = new Tracer(getConfig({
  logInjection: true,
  enabled: true,
  ...config
}))

const plugin = new TestLog({
  _tracer: tracer
})
plugin.configure({
  logInjection: true,
  enabled: true
})

describe('LogPlugin', () => {
  it('always adds service, version, and env', () => {
    const data = { message: {} }
    testLogChannel.publish(data)
    const { message } = data

    assert.deepStrictEqual(message.dd, config)

    // Should not have trace/span data when none is active
    assert.ok(!('trace_id' in message.dd))
    assert.ok(!('span_id' in message.dd))
  })

  it('should include trace_id and span_id when a span is active', () => {
    const span = tracer.startSpan('test')

    tracer.scope().activate(span, () => {
      const data = { message: {} }
      testLogChannel.publish(data)
      const { message } = data

      assertObjectContains(message.dd, config)

      // Should have trace/span data when none is active
      assert.strictEqual(message.dd.trace_id, span.context().toTraceId(true))
      assert.strictEqual(message.dd.span_id, span.context().toSpanId())
    })
  })
})
