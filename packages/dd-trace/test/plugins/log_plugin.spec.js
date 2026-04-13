'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
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

  it('does not add duplicate dd key when message already has a dd property', () => {
    const existingDd = { trace_id: 'existing-trace' }
    const data = { message: { level: 'info', dd: existingDd } }
    testLogChannel.publish(data)
    // Trigger the ownKeys trap — dd should appear exactly once
    const keys = Object.keys(data.message)
    assert.strictEqual(keys.filter(k => k === 'dd').length, 1)
    assert.strictEqual(data.message.dd, existingDd)
  })

  describe('log capture forwarding', () => {
    let captureSender

    beforeEach(() => {
      // Sender configuration is the responsibility of PluginManager, not LogPlugin.
      // Configure it directly here to keep these tests self-contained.
      // Do NOT clear the require cache — log_plugin.js holds a top-level reference to
      // the same sender module, so we must configure the same instance.
      captureSender = require('../../src/log-capture/sender')
      captureSender.stop() // reset any prior state
      captureSender.configure({
        host: 'localhost',
        port: 9999,
        path: '/logs',
        protocol: 'http:',
        maxBufferSize: 1000,
        flushIntervalMs: 5000,
        timeoutMs: 5000,
      })
    })

    afterEach(() => {
      captureSender.stop()
      plugin.configure({ logInjection: true, logCaptureEnabled: false, enabled: true })
    })

    it('forwards log records when capture is enabled', () => {
      plugin.configure({
        logInjection: false,
        logCaptureEnabled: true,
        enabled: true,
      })
      const data = { message: { level: 'info', msg: 'hello', time: Date.now() } }
      testLogChannel.publish(data)
      assert.strictEqual(captureSender.bufferSize(), 1)
    })

    it('does not forward when logCaptureEnabled is false', () => {
      plugin.configure({ logInjection: true, logCaptureEnabled: false, enabled: true })
      const data = { message: { level: 'info', msg: 'hello' } }
      testLogChannel.publish(data)
      assert.strictEqual(captureSender.bufferSize(), 0)
    })

    it('does not throw when log message cannot be serialized', () => {
      plugin.configure({
        logInjection: false,
        logCaptureEnabled: true,
        enabled: true,
      })
      const circular = {}
      circular.self = circular
      const data = { message: circular }
      testLogChannel.publish(data)
      assert.strictEqual(captureSender.bufferSize(), 0)
    })

    it('does not inject dd into actual message when logInjection is false', () => {
      plugin.configure({
        logInjection: false,
        logCaptureEnabled: true,
        enabled: true,
      })
      const data = { message: { level: 'info', msg: 'hello' } }
      testLogChannel.publish(data)
      assert.ok(!('dd' in data.message), 'actual message should not have dd when logInjection is false')
      assert.strictEqual(captureSender.bufferSize(), 1)
    })

    it('forwards captured record with dd proxy when logInjection and capture are both enabled', () => {
      plugin.configure({
        logInjection: true,
        logCaptureEnabled: true,
        enabled: true,
      })
      const data = { message: { level: 'info', msg: 'hello', time: Date.now() } }
      testLogChannel.publish(data)
      assert.strictEqual(captureSender.bufferSize(), 1)
    })
  })
})
