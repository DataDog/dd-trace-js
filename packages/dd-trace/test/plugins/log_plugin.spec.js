'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const { channel } = require('dc-polyfill')
const { storage } = require('../../../datadog-core')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
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
  version: '1.2.3',
}

const tracer = new Tracer(getConfig({
  logInjection: true,
  enabled: true,
  ...config,
}))

const plugin = new TestLog({
  _tracer: tracer,
})
plugin.configure({
  logInjection: true,
  enabled: true,
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

    storage('legacy').run({ span }, () => {
      const data = { message: {} }
      testLogChannel.publish(data)
      const { message } = data

      assertObjectContains(message.dd, config)

      // Should have trace/span data when a span is active
      assert.strictEqual(message.dd.trace_id, span.context().toTraceId(true))
      assert.strictEqual(message.dd.span_id, span.context().toSpanId())
    })
  })

  it('should allow overriding injected dd fields', () => {
    const data = { message: {} }
    testLogChannel.publish(data)

    const override = {
      trace_id: 'custom-trace-id',
      span_id: 'custom-span-id',
      service: 'custom-service',
    }

    data.message.dd = override

    assert.strictEqual(data.message.dd, override)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(data.message)), {
      dd: override,
    })
    assert.ok(Object.hasOwn(data.message, 'dd'))
  })

  it('should allow defining dd after injection', () => {
    const data = { message: {} }
    testLogChannel.publish(data)

    const override = {
      trace_id: 'custom-trace-id',
      span_id: 'custom-span-id',
    }

    Object.defineProperty(data.message, 'dd', {
      value: override,
      configurable: true,
      enumerable: true,
      writable: true,
    })

    assert.strictEqual(data.message.dd, override)
    assert.ok(Object.hasOwn(data.message, 'dd'))
  })
})
