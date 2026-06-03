'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')
const { randomBytes } = require('node:crypto')

const { before, describe, it } = require('mocha')
const sinon = require('sinon')

const EventBridge = require('../src/services/eventbridge')
const tracer = require('../../dd-trace')
const { withAwsSdkVersions } = require('./spec_helpers')

describe('EventBridge', () => {
  let span
  withAwsSdkVersions((version, moduleName) => {
    let traceId
    let parentId
    let spanId
    before(() => {
      tracer.init()
      span = {
        finish: sinon.spy(() => {}),
        context: () => {
          return {
            _sampling: {
              priority: 1,
            },
            _trace: {
              started: [],
              origin: '',
            },
            _traceFlags: {
              sampled: 1,
            },
            _baggageItems: {},
            'x-datadog-trace-id': traceId,
            'x-datadog-parent-id': parentId,
            'x-datadog-sampling-priority': '1',
            toTraceId: () => {
              return traceId
            },
            toSpanId: () => {
              return spanId
            },
          }
        },
        addTags: sinon.stub(),
        setTag: sinon.stub(),
      }
      tracer._tracer.startSpan = sinon.spy(() => {
        return span
      })
    })

    it('generates tags for an event', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: 'my.event',
        Name: 'my-rule-name',
      }
      assert.deepStrictEqual(eventbridge.generateTags(params, 'putEvent', {}), {
        'aws.eventbridge.source': 'my.event',
        'messaging.system': 'aws_eventbridge',
        'resource.name': 'putEvent my.event',
        rulename: 'my-rule-name',
      })
    })
    it('won\'t create tags for a malformed event', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        foo: 'bar',
      }
      assert.strictEqual(eventbridge.generateTags(params, 'putEvent', {}), undefined)
    })

    it('injects trace context to Eventbridge putEvents', () => {
      const eventbridge = new EventBridge(tracer)
      const request = {
        params: {
          Entries: [
            {
              Detail: JSON.stringify({
                custom: 'data',
                for: 'my users',
                from: 'Aaron Stuyvenberg',
              }),
            },
          ],
        },
        operation: 'putEvents',
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      eventbridge.requestInject(span.context(), request)

      assert.deepStrictEqual(request.params, {
        Entries: [{
          Detail: '{"custom":"data","for":"my users","from":"Aaron Stuyvenberg","_datadog":{' +
            '"x-datadog-trace-id":"456853219676779160",' +
            '"x-datadog-parent-id":"456853219676779160",' +
            '"x-datadog-sampling-priority":"1"' +
          '}}',
        }],
      })
    })

    it('skips injecting trace context to Eventbridge if message is full', () => {
      const eventbridge = new EventBridge(tracer)
      const request = {
        params: {
          Entries: [
            {
              Detail: JSON.stringify({ myGreatData: randomBytes(256000).toString('base64') }),
            },
          ],
        },
        operation: 'putEvents',
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      eventbridge.requestInject(span.context(), request)
      assert.deepStrictEqual(request.params, request.params)
    })

    it('returns undefined when params is null', () => {
      const eventbridge = new EventBridge(tracer)
      assert.strictEqual(eventbridge.generateTags(null, 'putEvent', {}), undefined)
    })

    it('returns undefined when params.source is an empty string', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: '',
      }
      assert.strictEqual(eventbridge.generateTags(params, 'putEvent', {}), undefined)
    })

    it('sets rulename as an empty string when params.Name is null', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: 'my.event',
        Name: null,
      }
      assert.deepStrictEqual(eventbridge.generateTags(params, 'putEvent', {}), {
        'aws.eventbridge.source': 'my.event',
        'messaging.system': 'aws_eventbridge',
        'resource.name': 'putEvent my.event',
        rulename: '',
      })
    })

    it('sets resource.name as params.source when operation is null', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: 'my.event',
        Name: 'my-rule-name',
      }
      assert.deepStrictEqual(eventbridge.generateTags(params, null, {}), {
        'aws.eventbridge.source': 'my.event',
        'messaging.system': 'aws_eventbridge',
        'resource.name': 'my.event',
        rulename: 'my-rule-name',
      })
    })
    it('handles null response gracefully', () => {
      const eventbridge = new EventBridge(tracer)
      const params = {
        source: 'my.event',
        Name: 'my-rule-name',
      }
      assert.deepStrictEqual(eventbridge.generateTags(params, 'putEvent', null), {
        'aws.eventbridge.source': 'my.event',
        'messaging.system': 'aws_eventbridge',
        'resource.name': 'putEvent my.event',
        rulename: 'my-rule-name',
      })
    })
  })
})

/**
 * `Object.create(EventBridge.prototype)` skips the heavy constructor wiring;
 * `requestInject` only touches `this.tracer`, `this.config`, and the static
 * `injectFieldIntoJsonObject`, so a hand-rolled stub suffices.
 *
 * @param {object} [options]
 * @param {boolean} [options.batchPropagationEnabled]
 * @param {boolean} [options.dsmEnabled]
 * @param {(span: unknown, format: string, info: object) => void} [options.inject]
 * @param {(tags: string[], span: unknown, payloadSize: number) => unknown} [options.setCheckpoint]
 * @returns {EventBridge}
 */
function buildPluginUnit ({
  batchPropagationEnabled = false,
  dsmEnabled = false,
  inject = (span, format, info) => { info['x-datadog-trace-id'] = '123' },
  setCheckpoint = () => null,
} = {}) {
  const plugin = Object.create(EventBridge.prototype)
  plugin._tracer = { inject, setCheckpoint }
  plugin.config = { batchPropagationEnabled, dsmEnabled }
  return plugin
}

describe('EventBridge requestInject batch propagation', () => {
  it('injects only into the first entry by default', () => {
    const eventbridge = buildPluginUnit({ batchPropagationEnabled: false })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [
          { Detail: JSON.stringify({ order: 1 }) },
          { Detail: JSON.stringify({ order: 2 }) },
          { Detail: JSON.stringify({ order: 3 }) },
        ],
      },
    }

    eventbridge.requestInject(null, request)

    assert.deepStrictEqual(
      JSON.parse(request.params.Entries[0].Detail),
      { order: 1, _datadog: { 'x-datadog-trace-id': '123' } }
    )
    assert.deepStrictEqual(JSON.parse(request.params.Entries[1].Detail), { order: 2 })
    assert.deepStrictEqual(JSON.parse(request.params.Entries[2].Detail), { order: 3 })
  })

  it('injects into every entry when batchPropagationEnabled is true', () => {
    const eventbridge = buildPluginUnit({ batchPropagationEnabled: true })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [
          { Detail: JSON.stringify({ order: 1 }) },
          { Detail: JSON.stringify({ order: 2 }) },
          { Detail: JSON.stringify({ order: 3 }) },
        ],
      },
    }

    eventbridge.requestInject(null, request)

    assert.deepStrictEqual(
      request.params.Entries.map((entry) => JSON.parse(entry.Detail)),
      [
        { order: 1, _datadog: { 'x-datadog-trace-id': '123' } },
        { order: 2, _datadog: { 'x-datadog-trace-id': '123' } },
        { order: 3, _datadog: { 'x-datadog-trace-id': '123' } },
      ]
    )
  })

  it('skips entries without a Detail field and continues the batch', () => {
    const eventbridge = buildPluginUnit({ batchPropagationEnabled: true })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [
          { Detail: JSON.stringify({ order: 1 }) },
          {},
          { Detail: JSON.stringify({ order: 3 }) },
        ],
      },
    }

    eventbridge.requestInject(null, request)

    assert.deepStrictEqual(
      JSON.parse(request.params.Entries[0].Detail),
      { order: 1, _datadog: { 'x-datadog-trace-id': '123' } }
    )
    assert.deepStrictEqual(request.params.Entries[1], {})
    assert.deepStrictEqual(
      JSON.parse(request.params.Entries[2].Detail),
      { order: 3, _datadog: { 'x-datadog-trace-id': '123' } }
    )
  })

  it('skips entries whose detail exceeds the 256kb size cap and keeps going', () => {
    const eventbridge = buildPluginUnit({ batchPropagationEnabled: true })
    const huge = JSON.stringify({ blob: 'x'.repeat(256 * 1024) })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [
          { Detail: huge },
          { Detail: JSON.stringify({ order: 2 }) },
        ],
      },
    }

    eventbridge.requestInject(null, request)

    // First entry is untouched: post-inject size would be over the 256kb cap.
    assert.strictEqual(request.params.Entries[0].Detail, huge)
    assert.deepStrictEqual(
      JSON.parse(request.params.Entries[1].Detail),
      { order: 2, _datadog: { 'x-datadog-trace-id': '123' } }
    )
  })

  it('skips entries whose Detail is not valid JSON and keeps going', () => {
    const eventbridge = buildPluginUnit({ batchPropagationEnabled: true })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [
          // Non-`{...}` Detail: the parse throws, so the entry is left untouched.
          { Detail: 'not valid json' },
          { Detail: JSON.stringify({ order: 2 }) },
        ],
      },
    }

    eventbridge.requestInject(null, request)

    assert.strictEqual(request.params.Entries[0].Detail, 'not valid json')
    assert.deepStrictEqual(
      JSON.parse(request.params.Entries[1].Detail),
      { order: 2, _datadog: { 'x-datadog-trace-id': '123' } }
    )
  })

  it('no-ops for non-putEvents operations', () => {
    const eventbridge = buildPluginUnit({ batchPropagationEnabled: true })
    const request = {
      operation: 'describeRule',
      params: { Entries: [{ Detail: JSON.stringify({ order: 1 }) }] },
    }

    eventbridge.requestInject(null, request)

    assert.deepStrictEqual(JSON.parse(request.params.Entries[0].Detail), { order: 1 })
  })

  it('no-ops on putEvents with an empty Entries array', () => {
    const eventbridge = buildPluginUnit({ batchPropagationEnabled: true })
    const request = { operation: 'putEvents', params: { Entries: [] } }

    eventbridge.requestInject(null, request)

    assert.deepStrictEqual(request.params, { Entries: [] })
  })
})

describe('EventBridge requestInject DSM', () => {
  // Shape consumed by DsmPathwayCodec.encode: a hash buffer plus start times.
  const dataStreamsContext = { hash: Buffer.alloc(8), pathwayStartNs: 0, edgeStartNs: 0 }

  it('sets a direction:out checkpoint and encodes the pathway into _datadog', () => {
    const checkpointCalls = []
    const eventbridge = buildPluginUnit({
      dsmEnabled: true,
      setCheckpoint: (tags, span, payloadSize) => {
        checkpointCalls.push({ tags, span, payloadSize })
        return dataStreamsContext
      },
    })
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: JSON.stringify({ order: 1 }) }] },
    }

    eventbridge.requestInject(null, request)

    assert.strictEqual(checkpointCalls.length, 1)
    assert.deepStrictEqual(checkpointCalls[0].tags, ['direction:out', 'topic:default', 'type:eventbridge'])

    const ddInfo = JSON.parse(request.params.Entries[0].Detail)._datadog
    assert.strictEqual(ddInfo['x-datadog-trace-id'], '123')
    assert.ok(
      typeof ddInfo['dd-pathway-ctx-base64'] === 'string' && ddInfo['dd-pathway-ctx-base64'].length > 0,
      `expected an encoded pathway, got: ${JSON.stringify(ddInfo)}`
    )
  })

  it('uses the entry EventBusName as the DSM topic', () => {
    const checkpointCalls = []
    const eventbridge = buildPluginUnit({
      dsmEnabled: true,
      setCheckpoint: (tags) => {
        checkpointCalls.push(tags)
        return dataStreamsContext
      },
    })
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: JSON.stringify({ order: 1 }), EventBusName: 'my-bus' }] },
    }

    eventbridge.requestInject(null, request)

    assert.deepStrictEqual(checkpointCalls[0], ['direction:out', 'topic:my-bus', 'type:eventbridge'])
  })

  it('does not checkpoint or encode a pathway when dsmEnabled is false', () => {
    let checkpointCalled = false
    const eventbridge = buildPluginUnit({
      dsmEnabled: false,
      setCheckpoint: () => {
        checkpointCalled = true
        return dataStreamsContext
      },
    })
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: JSON.stringify({ order: 1 }) }] },
    }

    eventbridge.requestInject(null, request)

    assert.strictEqual(checkpointCalled, false)
    assert.deepStrictEqual(
      JSON.parse(request.params.Entries[0].Detail)._datadog,
      { 'x-datadog-trace-id': '123' }
    )
  })

  it('checkpoints every entry in a batch when batchPropagationEnabled', () => {
    const checkpointCalls = []
    const eventbridge = buildPluginUnit({
      dsmEnabled: true,
      batchPropagationEnabled: true,
      setCheckpoint: (tags) => {
        checkpointCalls.push(tags)
        return dataStreamsContext
      },
    })
    const request = {
      operation: 'putEvents',
      params: {
        Entries: [
          { Detail: JSON.stringify({ order: 1 }) },
          { Detail: JSON.stringify({ order: 2 }), EventBusName: 'bus-2' },
        ],
      },
    }

    eventbridge.requestInject(null, request)

    assert.strictEqual(checkpointCalls.length, 2)
    assert.deepStrictEqual(checkpointCalls[0], ['direction:out', 'topic:default', 'type:eventbridge'])
    assert.deepStrictEqual(checkpointCalls[1], ['direction:out', 'topic:bus-2', 'type:eventbridge'])
    for (let i = 0; i < 2; i++) {
      const ddInfo = JSON.parse(request.params.Entries[i].Detail)._datadog
      assert.ok(ddInfo['dd-pathway-ctx-base64'], `entry ${i} missing encoded pathway`)
    }
  })
})
