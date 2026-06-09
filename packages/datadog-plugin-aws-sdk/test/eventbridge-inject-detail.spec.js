'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { describe, it } = require('mocha')

const { getHeadersSize } = require('../../dd-trace/src/datastreams')
const log = require('../../dd-trace/src/log')
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

describe('EventBridge plugin generateTags', () => {
  it('returns undefined when the source is missing', () => {
    const plugin = Object.create(EventBridge.prototype)

    assert.strictEqual(plugin.generateTags({}, 'putEvents'), undefined)
  })

  it('generates tags when the source is present', () => {
    const plugin = Object.create(EventBridge.prototype)

    assert.deepStrictEqual(plugin.generateTags({
      source: 'checkout',
      Name: 'rule-a',
    }), {
      'resource.name': 'checkout',
      'aws.eventbridge.source': 'checkout',
      'messaging.system': 'aws_eventbridge',
      rulename: 'rule-a',
    })
  })
})

describe('EventBridge plugin requestInject', () => {
  it('attaches `_datadog` before setDSMCheckpoint reads payload size', () => {
    const plugin = buildPlugin({ dsmEnabled: true })
    const entry = { Detail: '{"hello":"world"}' }

    plugin.injectToEntry(null, entry, false, true)

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

    plugin.injectToEntry(null, entry, true, true)

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

    plugin.injectToEntry(null, entry, false, true)

    const injected = JSON.parse(entry.Detail)._datadog
    assert.ok(typeof injected['dd-pathway-ctx-base64'] === 'string' && injected['dd-pathway-ctx-base64'].length > 0)
  })

  it('restores the original detail when DSM reinjection fails', () => {
    const plugin = buildPlugin({
      dsmEnabled: true,
      dataStreamsContext: {
        hash: Buffer.alloc(8),
        pathwayStartNs: 0,
        edgeStartNs: 0,
      },
    })
    const entry = { Detail: '{"hello":"world"}' }
    let injectDetailCalls = 0
    plugin.injectDetail = () => {
      injectDetailCalls++
      return injectDetailCalls === 1
        ? '{"hello":"world","_datadog":{}}'
        : undefined
    }

    plugin.injectToEntry(null, entry, false, true)

    assert.strictEqual(entry.Detail, '{"hello":"world"}')
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

  it('defaults to trace-only first-entry propagation when config is unset', () => {
    const plugin = Object.create(EventBridge.prototype)
    plugin._tracer = {
      inject: (span, format, carrier) => { carrier['x-datadog-trace-id'] = '123' },
      setCheckpoint: () => null,
    }
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

  it('skips rewriting non-propagated batch entries by default', () => {
    const plugin = buildPlugin({
      inject: (span, format, carrier) => { carrier['x-datadog-trace-id'] = '123' },
    })
    let injectDetailCalls = 0
    plugin.injectDetail = (...args) => {
      injectDetailCalls++
      return EventBridge.prototype.injectDetail.apply(plugin, args)
    }
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [
          { Detail: '{"id":1}' },
          { Detail: '{ "id": 2 }' },
        ],
      },
    }

    plugin.requestInject(null, request)

    assert.strictEqual(injectDetailCalls, 1)
    assert.strictEqual(request.params.Entries[1].Detail, '{ "id": 2 }')
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
      ['direction:out', 'type:eventbridge', 'topic:payments:invoice.created'],
      null,
      getHeadersSize(entry),
    ]])
  })

  it('uses the default event bus and detail type in the DSM checkpoint tags', () => {
    const calls = []
    const plugin = buildPlugin()
    plugin._tracer.setCheckpoint = (...args) => {
      calls.push(args)
      return null
    }
    const entry = { Detail: '{"id":1}' }

    EventBridge.prototype.setDSMCheckpoint.call(plugin, null, entry)

    assert.deepStrictEqual(calls, [[
      ['direction:out', 'type:eventbridge', 'topic:default:unknown'],
      null,
      getHeadersSize(entry),
    ]])
  })
})

describe('EventBridge plugin injectDetail', () => {
  it('logs and returns undefined when the detail is invalid JSON', () => {
    const plugin = buildPlugin()
    const originalError = log.error
    const calls = []
    log.error = (...args) => calls.push(args)

    try {
      assert.strictEqual(plugin.injectDetail('not-json', {}), undefined)
    } finally {
      log.error = originalError
    }

    assert.strictEqual(calls.length, 1)
  })

  it('logs and returns undefined when the payload is too large', () => {
    const plugin = buildPlugin()
    const originalInfo = log.info
    const calls = []
    log.info = (...args) => calls.push(args)

    try {
      assert.strictEqual(plugin.injectDetail(JSON.stringify({
        data: 'a'.repeat(1024 * 256),
      }), {}), undefined)
    } finally {
      log.info = originalInfo
    }

    assert.strictEqual(calls.length, 1)
  })
})
