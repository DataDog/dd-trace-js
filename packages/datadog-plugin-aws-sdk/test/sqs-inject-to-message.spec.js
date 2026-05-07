'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { describe, it } = require('mocha')

const Sqs = require('../src/services/sqs')

/**
 * `Object.create(Sqs.prototype)` skips the heavy plugin/diagnostic-channel
 * wiring in `BaseAwsSdkPlugin`'s constructor. The methods under test only
 * read `this.tracer` and `this.config` and call `this.setDSMCheckpoint`, so
 * a hand-rolled stub is enough to exercise the inject-time ordering.
 *
 * @param {object} options
 * @param {boolean} [options.dsmEnabled=false]
 * @param {(span: unknown, format: string, info: object) => void} [options.inject]
 *        Stand-in for `tracer.inject` that may populate the trace context
 *        in `info`.
 * @param {unknown} [options.dataStreamsContext=null]
 *        Value returned by the stubbed `setDSMCheckpoint`.
 * @returns {Sqs & { dsmCalls: Array<{ datadog: object | undefined }> }}
 */
function buildPlugin ({ dsmEnabled = false, inject = () => {}, dataStreamsContext = null } = {}) {
  const plugin = Object.create(Sqs.prototype)
  // `tracer` is a getter on the base Plugin class that reads `_tracer`.
  plugin._tracer = { inject }
  plugin.config = { dsmEnabled }
  plugin.dsmCalls = []
  plugin.setDSMCheckpoint = (span, params) => {
    // Snapshot `_datadog` at call time; the original code under test mutated
    // the same object after the call, so a reference would race the read.
    plugin.dsmCalls.push({
      datadog: params.MessageAttributes._datadog
        ? { ...params.MessageAttributes._datadog }
        : undefined,
    })
    return dataStreamsContext
  }
  return plugin
}

describe('Sqs plugin injectToMessage', () => {
  it('attaches `_datadog` before setDSMCheckpoint reads payload size', () => {
    const plugin = buildPlugin({ dsmEnabled: true })
    const params = { MessageBody: 'hello', MessageAttributes: {} }

    plugin.injectToMessage(null, params, 'http://example/queue', false)

    assert.strictEqual(plugin.dsmCalls.length, 1)
    assert.deepStrictEqual(plugin.dsmCalls[0].datadog, {
      DataType: 'String',
      StringValue: '{}',
    })
  })

  it('passes the injected trace context as the size placeholder', () => {
    const plugin = buildPlugin({
      dsmEnabled: true,
      inject: (span, format, info) => { info['x-datadog-trace-id'] = '123' },
    })
    const params = { MessageBody: 'hello', MessageAttributes: {} }

    plugin.injectToMessage(null, params, 'http://example/queue', true)

    assert.deepStrictEqual(plugin.dsmCalls[0].datadog, {
      DataType: 'String',
      StringValue: '{"x-datadog-trace-id":"123"}',
    })
  })

  it('drops `_datadog` when neither trace context nor DSM context attaches', () => {
    const plugin = buildPlugin({ dsmEnabled: true })
    const params = { MessageBody: 'hello', MessageAttributes: { existing: { DataType: 'String', StringValue: 'x' } } }

    plugin.injectToMessage(null, params, 'http://example/queue', false)

    assert.deepStrictEqual(params.MessageAttributes, { existing: { DataType: 'String', StringValue: 'x' } })
  })

  it('keeps the trace-only `_datadog` when DSM yields no context', () => {
    const plugin = buildPlugin({
      dsmEnabled: true,
      inject: (span, format, info) => { info['x-datadog-trace-id'] = '123' },
    })
    const params = { MessageBody: 'hello', MessageAttributes: {} }

    plugin.injectToMessage(null, params, 'http://example/queue', true)

    assert.deepStrictEqual(params.MessageAttributes._datadog, {
      DataType: 'String',
      StringValue: '{"x-datadog-trace-id":"123"}',
    })
  })

  it('updates `_datadog.StringValue` with the encoded pathway after setDSMCheckpoint', () => {
    const plugin = buildPlugin({
      dsmEnabled: true,
      dataStreamsContext: {
        hash: Buffer.alloc(8),
        pathwayStartNs: 0,
        edgeStartNs: 0,
      },
    })
    const params = { MessageBody: 'hello', MessageAttributes: {} }

    plugin.injectToMessage(null, params, 'http://example/queue', false)

    assert.strictEqual(plugin.dsmCalls[0].datadog.StringValue, '{}')
    const decoded = JSON.parse(params.MessageAttributes._datadog.StringValue)
    assert.ok(typeof decoded['dd-pathway-ctx-base64'] === 'string' && decoded['dd-pathway-ctx-base64'].length > 0)
  })

  it('skips `_datadog` entirely when DSM is disabled and trace inject yields nothing', () => {
    const plugin = buildPlugin({ dsmEnabled: false })
    const params = { MessageBody: 'hello', MessageAttributes: {} }

    plugin.injectToMessage(null, params, 'http://example/queue', true)

    assert.deepStrictEqual(params.MessageAttributes, {})
  })

  it('attaches `_datadog` with the injected trace context when DSM is disabled', () => {
    const plugin = buildPlugin({
      dsmEnabled: false,
      inject: (span, format, info) => { info['x-datadog-trace-id'] = '123' },
    })
    const params = { MessageBody: 'hello', MessageAttributes: {} }

    plugin.injectToMessage(null, params, 'http://example/queue', true)

    assert.deepStrictEqual(params.MessageAttributes._datadog, {
      DataType: 'String',
      StringValue: '{"x-datadog-trace-id":"123"}',
    })
  })

  it('skips injection at the SQS quota of 10 attributes', () => {
    const plugin = buildPlugin({
      dsmEnabled: true,
      inject: (span, format, info) => { info['x-datadog-trace-id'] = '123' },
    })
    const MessageAttributes = {}
    for (let i = 0; i < 10; i++) {
      MessageAttributes[`attr${i}`] = { DataType: 'String', StringValue: String(i) }
    }
    const params = { MessageBody: 'hello', MessageAttributes }
    const original = { ...MessageAttributes }

    plugin.injectToMessage(null, params, 'http://example/queue', true)

    assert.strictEqual(plugin.dsmCalls.length, 0)
    assert.deepStrictEqual(params.MessageAttributes, original)
  })

  it('still injects when one slot is free at the SQS quota boundary', () => {
    const plugin = buildPlugin({
      dsmEnabled: false,
      inject: (span, format, info) => { info['x-datadog-trace-id'] = '123' },
    })
    const MessageAttributes = {}
    for (let i = 0; i < 9; i++) {
      MessageAttributes[`attr${i}`] = { DataType: 'String', StringValue: String(i) }
    }
    const params = { MessageBody: 'hello', MessageAttributes }

    plugin.injectToMessage(null, params, 'http://example/queue', true)

    assert.deepStrictEqual(params.MessageAttributes._datadog, {
      DataType: 'String',
      StringValue: '{"x-datadog-trace-id":"123"}',
    })
  })

  it('counts only own keys against the SQS quota when the object inherits enumerable keys', () => {
    const plugin = buildPlugin({
      dsmEnabled: false,
      inject: (span, format, info) => { info['x-datadog-trace-id'] = '123' },
    })
    const inherited = {}
    for (let i = 0; i < 12; i++) {
      inherited[`inherited${i}`] = { DataType: 'String', StringValue: String(i) }
    }
    const params = {
      MessageBody: 'hello',
      MessageAttributes: Object.assign(Object.create(inherited), { own: { DataType: 'String', StringValue: 'x' } }),
    }

    plugin.injectToMessage(null, params, 'http://example/queue', true)

    assert.deepStrictEqual(params.MessageAttributes._datadog, {
      DataType: 'String',
      StringValue: '{"x-datadog-trace-id":"123"}',
    })
  })
})
