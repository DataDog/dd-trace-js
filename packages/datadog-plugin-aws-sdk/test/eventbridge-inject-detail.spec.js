'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { describe, it } = require('mocha')

const { getHeadersSize } = require('../../dd-trace/src/datastreams')
const EventBridge = require('../src/services/eventbridge')

/**
 * Build a lightweight EventBridge plugin instance for unit-testing the
 * request-mutation logic without wiring diagnostic channels.
 *
 * @param {object} [options]
 * @param {boolean} [options.dsmEnabled]
 * @param {boolean} [options.batchPropagationEnabled]
 * @param {(span: unknown, format: string, carrier: object) => void} [options.inject]
 * @param {object|null} [options.dataStreamsContext]
 * @returns {EventBridge & { dsmCalls: Array<{ detail: string }> }}
 */
function buildPlugin ({
  dsmEnabled = false,
  batchPropagationEnabled = false,
  inject = () => {},
  dataStreamsContext = null,
} = {}) {
  const plugin = Object.create(EventBridge.prototype)
  plugin._tracer = { inject, setCheckpoint: () => null }
  plugin.config = { dsmEnabled, batchPropagationEnabled }
  plugin.dsmCalls = []
  plugin.setDSMCheckpoint = (span, entry) => {
    plugin.dsmCalls.push({ detail: entry.Detail })
    return dataStreamsContext
  }
  return plugin
}

describe('EventBridge plugin requestInject', () => {
  it('attaches `_datadog` before setDSMCheckpoint reads payload size', () => {
    const plugin = buildPlugin({ dsmEnabled: true })
    const entry = { Detail: '{"hello":"world"}' }

    plugin.injectToEntry(null, entry, false)

    assert.strictEqual(plugin.dsmCalls.length, 1)
    assert.deepStrictEqual(JSON.parse(plugin.dsmCalls[0].detail)._datadog, {})
    assert.strictEqual(entry.Detail, '{"hello":"world"}')
  })

  it('keeps the trace-only `_datadog` payload when DSM yields no context', () => {
    const plugin = buildPlugin({
      dsmEnabled: true,
      inject: (span, format, carrier) => { carrier['x-datadog-trace-id'] = '123' },
    })
    const entry = { Detail: '{"hello":"world"}' }

    plugin.injectToEntry(null, entry, true)

    assert.deepStrictEqual(JSON.parse(entry.Detail)._datadog, {
      'x-datadog-trace-id': '123',
    })
  })

  it('adds the encoded DSM context to `_datadog`', () => {
    const plugin = buildPlugin({
      dsmEnabled: true,
      dataStreamsContext: {
        hash: Buffer.alloc(8),
        pathwayStartNs: 0,
        edgeStartNs: 0,
      },
    })
    const entry = { Detail: '{"hello":"world"}' }

    plugin.injectToEntry(null, entry, false)

    const injected = JSON.parse(entry.Detail)._datadog
    assert.ok(typeof injected['dd-pathway-ctx-base64'] === 'string' && injected['dd-pathway-ctx-base64'].length > 0)
  })

  it('injects only the first batch entry by default', () => {
    const plugin = buildPlugin({
      inject: (span, format, carrier) => { carrier['x-datadog-trace-id'] = '123' },
    })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [
          { Detail: '{"id":1}' },
          { Detail: '{"id":2}' },
        ],
      },
    }

    plugin.requestInject(null, request)

    assert.deepStrictEqual(JSON.parse(request.params.Entries[0].Detail)._datadog, {
      'x-datadog-trace-id': '123',
    })
    assert.strictEqual(request.params.Entries[1].Detail, '{"id":2}')
  })

  it('injects DSM context into every batch entry by default', () => {
    const plugin = buildPlugin({
      dsmEnabled: true,
      dataStreamsContext: {
        hash: Buffer.alloc(8),
        pathwayStartNs: 0,
        edgeStartNs: 0,
      },
    })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [
          { Detail: '{"id":1}' },
          { Detail: '{"id":2}' },
        ],
      },
    }

    plugin.requestInject(null, request)

    const first = JSON.parse(request.params.Entries[0].Detail)._datadog
    const second = JSON.parse(request.params.Entries[1].Detail)._datadog
    assert.ok(typeof first['dd-pathway-ctx-base64'] === 'string' && first['dd-pathway-ctx-base64'].length > 0)
    assert.ok(typeof second['dd-pathway-ctx-base64'] === 'string' && second['dd-pathway-ctx-base64'].length > 0)
  })

  it('injects all batch entries when batchPropagationEnabled is enabled', () => {
    const plugin = buildPlugin({
      batchPropagationEnabled: true,
      inject: (span, format, carrier) => { carrier['x-datadog-trace-id'] = '123' },
    })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [
          { Detail: '{"id":1}' },
          { Detail: '{"id":2}' },
        ],
      },
    }

    plugin.requestInject(null, request)

    assert.deepStrictEqual(JSON.parse(request.params.Entries[0].Detail)._datadog, {
      'x-datadog-trace-id': '123',
    })
    assert.deepStrictEqual(JSON.parse(request.params.Entries[1].Detail)._datadog, {
      'x-datadog-trace-id': '123',
    })
  })

  it('uses the event bus and detail type in the DSM checkpoint tags', () => {
    const calls = []
    const plugin = buildPlugin()
    plugin._tracer.setCheckpoint = (...args) => {
      calls.push(args)
      return null
    }
    const entry = {
      EventBusName: 'payments',
      DetailType: 'invoice.created',
      Detail: '{"id":1}',
    }

    EventBridge.prototype.setDSMCheckpoint.call(plugin, null, entry)

    assert.deepStrictEqual(calls, [[
      ['direction:out', 'type:eventbridge:payments', 'topic:invoice.created'],
      null,
      getHeadersSize(entry),
    ]])
  })
})
