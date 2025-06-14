'use strict'

require('../setup/tap')

const LogPlugin = require('../../src/plugins/log_plugin')
const BunyanPlugin = require('../../../datadog-plugin-bunyan/src/index')
const Tracer = require('../../src/tracer')
const Config = require('../../src/config')

const { channel } = require('dc-polyfill')
const { expect } = require('chai')

const testLogChannel = channel('apm:test:log')

class TestLog extends LogPlugin {
  static get id () {
    return 'test'
  }
}

const config = {
  env: 'my-env',
  service: 'my-service',
  version: '1.2.3'
}

const tracer = new Tracer(new Config({
  logInjection: true,
  enabled: true,
  ...config
}))

let plugin = new TestLog({
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

    expect(message.dd).to.deep.equal(config)

    // Should not have trace/span data when none is active
    expect(message.dd).to.not.have.property('trace_id')
    expect(message.dd).to.not.have.property('span_id')
  })

  it('should include trace_id and span_id when a span is active', () => {
    const span = tracer.startSpan('test')

    tracer.scope().activate(span, () => {
      const data = { message: {} }
      testLogChannel.publish(data)
      const { message } = data

      expect(message.dd).to.contain(config)

      // Should have trace/span data when none is active
      expect(message.dd).to.have.property('trace_id', span.context().toTraceId(true))
      expect(message.dd).to.have.property('span_id', span.context().toSpanId())
    })
  })

  it('should inject logs for only structured loggers when logInjection is structured', () => {
    plugin.configure({
      logInjection: 'structured',
      enabled: true
    })
    const unstructuredLoggerSpan = tracer.startSpan('unstructured logger')

    tracer.scope().activate(unstructuredLoggerSpan, () => {
      const data = { message: {} }
      testLogChannel.publish(data)
      const { message } = data

      expect(message.dd).to.be.undefined
    })

    plugin = new BunyanPlugin({
      _tracer: tracer
    })
    plugin.configure({
      logInjection: 'structured',
      enabled: true
    })

    const structuredLoggerSpan = tracer.startSpan('structured logger')
    const structuredLogChannel = channel('apm:bunyan:log')

    tracer.scope().activate(structuredLoggerSpan, () => {
      const data = { message: {} }
      structuredLogChannel.publish(data)
      const { message } = data

      expect(message.dd).to.contain(config)

      expect(message.dd).to.have.property('trace_id', structuredLoggerSpan.context().toTraceId(true))
      expect(message.dd).to.have.property('span_id', structuredLoggerSpan.context().toSpanId())
    })
  })
})
