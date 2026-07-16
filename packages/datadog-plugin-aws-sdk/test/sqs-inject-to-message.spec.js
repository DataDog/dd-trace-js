'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')
const { inspect } = require('node:util')

const { describe, it } = require('mocha')

const Sqs = require('../src/services/sqs')

const QueueUrl = 'http://127.0.0.1:4566/00000000000000000000/test-queue'

/** @typedef {Sqs & { dsmCalls: Array<{ datadog: object | undefined }> }} TestSqs */

/**
 * @param {object} options
 * @param {boolean} [options.dsmEnabled]
 * @param {(span: unknown, format: string, info?: object) => object | undefined} [options.inject]
 * @param {(format: string, attrs: object) => unknown} [options.extract]
 * @param {(carrier: object) => void} [options.decodeDataStreamsContext]
 * @param {(tags: string[], span: unknown, payloadSize: number) => unknown} [options.setCheckpoint]
 * @param {unknown} [options.dataStreamsContext] Value returned by stubbed `setDSMCheckpoint`.
 * @returns {TestSqs}
 */
function buildPlugin ({
  dsmEnabled = false,
  inject = () => undefined,
  extract = () => undefined,
  decodeDataStreamsContext = () => {},
  setCheckpoint = () => null,
  dataStreamsContext = null,
} = {}) {
  const tracer = { inject, extract, decodeDataStreamsContext, setCheckpoint }
  const plugin = /** @type {TestSqs} */ (new Sqs(tracer, {}))
  plugin.config = { dsmEnabled }
  plugin.dsmCalls = []

  /**
   * @param {unknown} span
   * @param {{ MessageAttributes: Record<string, object> }} params
   * @returns {unknown}
   */
  function setDSMCheckpoint (span, params) {
    // Snapshot `_datadog` at call time; the original code under test mutated
    // the same object after the call, so a reference would race the read.
    plugin.dsmCalls.push({
      datadog: params.MessageAttributes._datadog
        ? { ...params.MessageAttributes._datadog }
        : undefined,
    })
    return dataStreamsContext
  }
  plugin.setDSMCheckpoint = setDSMCheckpoint
  return plugin
}

/**
 * @param {unknown} span
 * @param {string} format
 * @param {Record<string, string>} [carrier]
 * @returns {Record<string, string>}
 */
function injectTraceContext (span, format, carrier = {}) {
  carrier['x-datadog-trace-id'] = '123'
  return carrier
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
      inject: injectTraceContext,
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
      inject: injectTraceContext,
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
    const pathwayCtx = decoded['dd-pathway-ctx-base64']
    assert.ok(
      typeof pathwayCtx === 'string' && pathwayCtx.length > 0,
      `Expected non-empty pathway ctx string, got ${inspect(pathwayCtx)}`
    )
  })

  it('attaches `_datadog` with the injected trace context when DSM is disabled', () => {
    const plugin = buildPlugin({
      dsmEnabled: false,
      inject: injectTraceContext,
    })
    const params = { MessageBody: 'hello', MessageAttributes: {} }

    plugin.injectToMessage(null, params, 'http://example/queue', true)

    assert.deepStrictEqual(params.MessageAttributes._datadog, {
      DataType: 'String',
      StringValue: '{"x-datadog-trace-id":"123"}',
    })
  })

  it('does not attach `_datadog` when DSM is disabled and trace injection writes nothing', () => {
    const plugin = buildPlugin()
    const params = { MessageBody: 'hello', MessageAttributes: {} }

    plugin.injectToMessage(null, params, 'http://example/queue', true)

    assert.deepStrictEqual(params.MessageAttributes, {})
  })

  it('skips injection at the SQS quota of 10 attributes', () => {
    const plugin = buildPlugin({
      dsmEnabled: true,
      inject: injectTraceContext,
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
      inject: injectTraceContext,
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
      inject: injectTraceContext,
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

// Fixtures for the EventBridge extraction matrix. `ebEnvelope(datadog)` builds
// a PutEvents-delivered envelope (omitting `_datadog` when none is passed);
// `snsWrap(message)` wraps a payload as an SNS `Notification` body.
const ebEnvelope = (datadog) => ({
  version: '0',
  'detail-type': 'orderPlaced',
  source: 'my.app',
  detail: { orderId: 'o-1', ...(datadog && { _datadog: datadog }) },
})

const snsWrap = (message) => ({
  Type: 'Notification',
  Message: typeof message === 'string' ? message : JSON.stringify(message),
})

// `responseExtract` returns the raw `_datadog` text-map carrier per message (in message
// order, `undefined` where absent). `#startResponseSpan` is what turns the carriers into
// the parent context plus span links; that wiring is covered by the integration suite.
describe('Sqs plugin responseExtract', () => {
  it('parses the carrier from MessageAttributes._datadog (direct SQS to SQS)', () => {
    const plugin = buildPlugin()

    const carriers = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      {
        Messages: [{
          Body: 'opaque payload — body is not JSON',
          MessageAttributes: {
            _datadog: {
              DataType: 'String',
              StringValue: JSON.stringify({
                'x-datadog-trace-id': '111',
                'x-datadog-parent-id': '222',
                'x-datadog-sampling-priority': '1',
              }),
            },
          },
        }],
      }
    )

    assert.deepStrictEqual(carriers, [{
      'x-datadog-trace-id': '111',
      'x-datadog-parent-id': '222',
      'x-datadog-sampling-priority': '1',
    }])
  })

  it('parses the carrier from the SNS Notification body wrapper (SNS to SQS)', () => {
    const plugin = buildPlugin()

    const snsBody = {
      Type: 'Notification',
      MessageId: 'msg-1',
      TopicArn: 'arn:aws:sns:us-east-1:000000000000:topic',
      Message: 'inner sns payload',
      MessageAttributes: {
        _datadog: {
          Type: 'Binary',
          Value: Buffer.from(JSON.stringify({
            'x-datadog-trace-id': '333',
            'x-datadog-parent-id': '444',
          })).toString('base64'),
        },
      },
    }

    const carriers = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      { Messages: [{ Body: JSON.stringify(snsBody) }] }
    )

    assert.deepStrictEqual(carriers, [{
      'x-datadog-trace-id': '333',
      'x-datadog-parent-id': '444',
    }])
  })

  it('yields an undefined carrier when neither MessageAttributes nor SNS body carry _datadog', () => {
    const plugin = buildPlugin()

    const carriers = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      { Messages: [{ Body: 'plain text', MessageAttributes: {} }] }
    )

    assert.deepStrictEqual(carriers, [undefined])
  })

  it('parses the carrier from EventBridge body.detail._datadog (EventBridge to SQS)', () => {
    const plugin = buildPlugin()

    const datadog = { 'x-datadog-trace-id': '999', 'x-datadog-parent-id': '888', 'x-datadog-sampling-priority': '1' }
    const carriers = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      { Messages: [{ Body: JSON.stringify(ebEnvelope(datadog)) }] }
    )

    assert.deepStrictEqual(carriers, [datadog])
  })

  it('falls through cleanly when an EventBridge envelope has no `_datadog` in detail', () => {
    const plugin = buildPlugin()

    const carriers = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      { Messages: [{ Body: JSON.stringify(ebEnvelope()) }] }
    )

    assert.deepStrictEqual(carriers, [undefined])
  })

  it('parses the carrier from an EventBridge envelope wrapped in an SNS Notification', () => {
    const plugin = buildPlugin()

    const datadog = { 'x-datadog-trace-id': '555', 'x-datadog-parent-id': '444' }
    const carriers = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      { Messages: [{ Body: JSON.stringify(snsWrap(ebEnvelope(datadog))) }] }
    )

    assert.deepStrictEqual(carriers, [datadog])
  })

  it('falls through when an SNS Notification Message is not an EventBridge envelope', () => {
    const plugin = buildPlugin()

    const carriers = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      { Messages: [{ Body: JSON.stringify(snsWrap('a plain string payload, not JSON')) }] }
    )

    assert.deepStrictEqual(carriers, [undefined])
  })

  // Both carriers present: MessageAttributes must win and the body is never consulted.
  it('prefers MessageAttributes over the EventBridge body when both are present', () => {
    const plugin = buildPlugin()

    const carriers = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      {
        Messages: [{
          Body: JSON.stringify(ebEnvelope({ 'x-datadog-trace-id': 'from-body' })),
          MessageAttributes: {
            _datadog: {
              DataType: 'String',
              StringValue: JSON.stringify({ 'x-datadog-trace-id': 'from-attrs' }),
            },
          },
        }],
      }
    )

    assert.deepStrictEqual(carriers, [{ 'x-datadog-trace-id': 'from-attrs' }])
  })

  it('returns a carrier per message for a multi-message receive, undefined where absent', () => {
    const plugin = buildPlugin()

    const first = { 'x-datadog-trace-id': '1', 'x-datadog-parent-id': '11' }
    const third = { 'x-datadog-trace-id': '3', 'x-datadog-parent-id': '33' }
    const carriers = plugin.responseExtract(
      { QueueUrl, MaxNumberOfMessages: 10 },
      'receiveMessage',
      {
        Messages: [
          {
            Body: 'opaque',
            MessageAttributes: { _datadog: { DataType: 'String', StringValue: JSON.stringify(first) } },
          },
          { Body: 'no context here', MessageAttributes: {} },
          { Body: JSON.stringify(ebEnvelope(third)) },
        ],
      }
    )

    assert.deepStrictEqual(carriers, [first, undefined, third])
  })

  it('returns undefined for a non-receiveMessage operation', () => {
    const plugin = buildPlugin()

    assert.strictEqual(plugin.responseExtract({ QueueUrl }, 'sendMessage', { Messages: [{ Body: 'x' }] }), undefined)
  })

  it('returns undefined when the receive yields no messages', () => {
    const plugin = buildPlugin()

    assert.strictEqual(plugin.responseExtract({ QueueUrl }, 'receiveMessage', { Messages: [] }), undefined)
    assert.strictEqual(plugin.responseExtract({ QueueUrl }, 'receiveMessage', {}), undefined)
  })
})

describe('Sqs plugin responseExtractDSMContext', () => {
  it('decodes DSM context from EventBridge body.detail._datadog when dsmEnabled', () => {
    let decodedCarrier
    const setCheckpointCalls = []
    const plugin = buildPlugin({
      dsmEnabled: true,
      decodeDataStreamsContext: (carrier) => { decodedCarrier = carrier },
      setCheckpoint: (tags, span, payloadSize) => {
        setCheckpointCalls.push({ tags, span, payloadSize })
        return null
      },
    })

    const datadog = { 'x-datadog-trace-id': '777', 'x-datadog-parent-id': '666' }
    plugin.responseExtractDSMContext(
      'receiveMessage',
      { QueueUrl },
      { Messages: [{ Body: JSON.stringify(ebEnvelope(datadog)) }] },
      null
    )

    assert.deepStrictEqual(decodedCarrier, datadog)
    assert.strictEqual(setCheckpointCalls.length, 1)
    assert.deepStrictEqual(setCheckpointCalls[0].tags, [
      'direction:in',
      'topic:test-queue',
      'type:sqs',
    ])
  })

  it('decodes DSM context from an EventBridge envelope wrapped in an SNS Notification', () => {
    let decodedCarrier
    const plugin = buildPlugin({
      dsmEnabled: true,
      decodeDataStreamsContext: (carrier) => { decodedCarrier = carrier },
    })

    const datadog = { 'x-datadog-trace-id': '555', 'x-datadog-parent-id': '444' }
    plugin.responseExtractDSMContext(
      'receiveMessage',
      { QueueUrl },
      { Messages: [{ Body: JSON.stringify(snsWrap(ebEnvelope(datadog))) }] },
      null
    )

    assert.deepStrictEqual(decodedCarrier, datadog)
  })

  it('does not decode anything when dsmEnabled is false', () => {
    let decodeCalled = false
    const plugin = buildPlugin({
      dsmEnabled: false,
      decodeDataStreamsContext: () => { decodeCalled = true },
    })

    plugin.responseExtractDSMContext(
      'receiveMessage',
      { QueueUrl },
      { Messages: [{ Body: JSON.stringify(ebEnvelope({ 'x-datadog-trace-id': '777' })) }] },
      null
    )

    assert.strictEqual(decodeCalled, false)
  })

  it('attributes the checkpoint to the span for a single-message receive', () => {
    const spans = []
    const plugin = buildPlugin({
      dsmEnabled: true,
      setCheckpoint: (tags, span) => { spans.push(span); return null },
    })
    const consumerSpan = { id: 'consumer' }

    plugin.responseExtractDSMContext('receiveMessage', { QueueUrl }, { Messages: [{ Body: 'a' }] }, consumerSpan)

    assert.deepStrictEqual(spans, [consumerSpan])
  })

  it('detaches the span and checkpoints once per message for a multi-message receive', () => {
    const spans = []
    const plugin = buildPlugin({
      dsmEnabled: true,
      setCheckpoint: (tags, span) => { spans.push(span); return null },
    })

    plugin.responseExtractDSMContext(
      'receiveMessage',
      { QueueUrl },
      { Messages: [{ Body: 'a' }, { Body: 'b' }] },
      { id: 'consumer' }
    )

    // More than one message: payloadSize must not be attributed to the consumer span.
    assert.deepStrictEqual(spans, [null, null])
  })

  it('decodes the pre-parsed carriers instead of re-parsing each body', () => {
    const decoded = []
    const plugin = buildPlugin({
      dsmEnabled: true,
      decodeDataStreamsContext: (carrier) => { decoded.push(carrier) },
    })

    const carrier = { 'x-datadog-trace-id': '42' }
    plugin.responseExtractDSMContext(
      'receiveMessage',
      { QueueUrl },
      // Bodies are unparseable JSON: reached only if the carriers were ignored.
      { Messages: [{ Body: 'not json {' }, { Body: 'also not json {' }] },
      null,
      [carrier, undefined]
    )

    assert.deepStrictEqual(decoded, [carrier])
  })

  it('returns without checkpoints when the receive yields no messages', () => {
    let checkpoints = 0
    const plugin = buildPlugin({ dsmEnabled: true, setCheckpoint: () => { checkpoints++; return null } })

    plugin.responseExtractDSMContext('receiveMessage', { QueueUrl }, { Messages: [] }, null)

    assert.strictEqual(checkpoints, 0)
  })
})
