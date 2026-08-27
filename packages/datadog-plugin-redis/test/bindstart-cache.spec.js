'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

require('../../dd-trace/test/setup/core')

const RedisPlugin = require('../src')

function makeTracerStub (startSpan) {
  return {
    _service: 'tracer-svc',
    startSpan,
  }
}

function makeCtx (connectionName) {
  return {
    db: 0,
    command: 'get',
    args: ['foo'],
    argsStartIndex: 0,
    connectionOptions: { host: '127.0.0.1', port: 6379 },
    connectionName,
    currentStore: {},
  }
}

describe('RedisPlugin bindStart service caching', () => {
  let plugin
  let startSpan
  let tracerConfig

  beforeEach(() => {
    startSpan = sinon.stub().returns({
      _spanContext: { _tags: {} },
      setTag () {},
      finish () {},
      addLink () {},
    })
    tracerConfig = {
      codeOriginForSpans: { enabled: false, experimental: { exit_spans: { enabled: false } } },
      service: 'tracer-svc',
      spanAttributeSchema: 'v0',
      spanRemoveIntegrationFromService: false,
    }
    plugin = new RedisPlugin(makeTracerStub(startSpan), tracerConfig)
    plugin.configure({
      service: 'custom',
      splitByInstance: true,
      enabled: false,
    })
  })

  it('caches the service name across repeated bindStart calls with the same connection', () => {
    plugin.bindStart(makeCtx('test'))
    plugin.bindStart(makeCtx('test'))

    assert.strictEqual(startSpan.firstCall.args[1].tags['service.name'], 'custom-test')
    assert.strictEqual(startSpan.secondCall.args[1].tags['service.name'], 'custom-test')
  })

  it('re-derives the service name when the schema changes', () => {
    plugin.bindStart(makeCtx('test'))
    assert.strictEqual(startSpan.firstCall.args[1].tags['service.name'], 'custom-test')

    tracerConfig.spanAttributeSchema = 'v1'
    plugin.configure({
      service: 'custom',
      splitByInstance: true,
      enabled: false,
    })

    plugin.bindStart(makeCtx('test'))
    assert.strictEqual(startSpan.secondCall.args[1].tags['service.name'], 'custom')
  })

  it('clears the cache on configure() so a new plugin config takes effect', () => {
    plugin.bindStart(makeCtx('test'))
    assert.strictEqual(startSpan.firstCall.args[1].tags['service.name'], 'custom-test')

    plugin.configure({
      service: 'renamed',
      splitByInstance: true,
      enabled: false,
    })

    plugin.bindStart(makeCtx('test'))
    assert.strictEqual(startSpan.secondCall.args[1].tags['service.name'], 'renamed-test')
  })

  it('still caches across multiple connections separately', () => {
    plugin.bindStart(makeCtx('a'))
    plugin.bindStart(makeCtx('b'))
    plugin.bindStart(makeCtx('a'))
    plugin.bindStart(makeCtx('b'))

    const calls = startSpan.getCalls()
    assert.strictEqual(calls[0].args[1].tags['service.name'], 'custom-a')
    assert.strictEqual(calls[1].args[1].tags['service.name'], 'custom-b')
    assert.strictEqual(calls[2].args[1].tags['service.name'], 'custom-a')
    assert.strictEqual(calls[3].args[1].tags['service.name'], 'custom-b')
  })
})
