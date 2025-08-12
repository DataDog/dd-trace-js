'use strict'

require('../setup/tap')

const LogPlugin = require('../../src/plugins/log_plugin')
const Tracer = require('../../src/tracer')
const Config = require('../../src/config')

const { channel } = require('dc-polyfill')
const { expect } = require('chai')

const testLogChannel = channel('apm:test:log')

class TestLog extends LogPlugin {
  static id = 'test'
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
})
