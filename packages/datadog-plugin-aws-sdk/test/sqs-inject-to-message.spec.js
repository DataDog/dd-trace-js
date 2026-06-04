'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')
const { inspect } = require('node:util')

const { describe, it } = require('mocha')

const Sqs = require('../src/services/sqs')

const QueueUrl = 'http://127.0.0.1:4566/00000000000000000000/test-queue'

/**
 * `Object.create(Sqs.prototype)` skips the heavy constructor wiring in
 * `BaseAwsSdkPlugin`; the methods under test only touch `this.tracer`,
 * `this.config`, and `this.setDSMCheckpoint`, so a hand-rolled stub suffices.
 * The options stub the corresponding `tracer` methods.
 *
 * @param {object} options
 * @param {boolean} [options.dsmEnabled]
 * @param {(span: unknown, format: string, info: object) => void} [options.inject]
 * @param {(format: string, attrs: object) => unknown} [options.extract]
 * @param {(carrier: object) => void} [options.decodeDataStreamsContext]
 * @param {(tags: string[], span: unknown, payloadSize: number) => unknown} [options.setCheckpoint]
 * @param {unknown} [options.dataStreamsContext] Value returned by stubbed `setDSMCheckpoint`.
 * @returns {Sqs & { dsmCalls: Array<{ datadog: object | undefined }> }}
 */
function buildPlugin ({
  dsmEnabled = false,
  inject = () => {},
  extract = () => undefined,
  decodeDataStreamsContext = () => {},
  setCheckpoint = () => null,
  dataStreamsContext = null,
} = {}) {
  const plugin = Object.create(Sqs.prototype)
  // `tracer` is a getter on the base Plugin class that reads `_tracer`.
  plugin._tracer = { inject, extract, decodeDataStreamsContext, setCheckpoint }
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
    const pathwayCtx = decoded['dd-pathway-ctx-base64']
    assert.ok(
      typeof pathwayCtx === 'string' && pathwayCtx.length > 0,
      `Expected non-empty pathway ctx string, got ${inspect(pathwayCtx)}`
    )
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

describe('Sqs plugin responseExtract', () => {
  it('extracts trace context from MessageAttributes._datadog (direct SQS to SQS)', () => {
    let receivedAttributes
    const plugin = buildPlugin({
      extract: (format, attrs) => {
        receivedAttributes = attrs
        return 'sqs-native-context'
      },
    })

    const result = plugin.responseExtract(
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

    assert.deepStrictEqual(receivedAttributes, {
      'x-datadog-trace-id': '111',
      'x-datadog-parent-id': '222',
      'x-datadog-sampling-priority': '1',
    })
    assert.strictEqual(result.datadogContext, 'sqs-native-context')
  })

  it('extracts trace context from the SNS Notification body wrapper (SNS to SQS)', () => {
    let receivedAttributes
    const plugin = buildPlugin({
      extract: (format, attrs) => {
        receivedAttributes = attrs
        return 'sns-context'
      },
    })

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

    const result = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      { Messages: [{ Body: JSON.stringify(snsBody) }] }
    )

    assert.deepStrictEqual(receivedAttributes, {
      'x-datadog-trace-id': '333',
      'x-datadog-parent-id': '444',
    })
    assert.strictEqual(result.datadogContext, 'sns-context')
  })

  it('returns no datadogContext when neither MessageAttributes nor SNS body carry _datadog', () => {
    let extractCalled = false
    const plugin = buildPlugin({ extract: () => { extractCalled = true } })

    const result = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      { Messages: [{ Body: 'plain text', MessageAttributes: {} }] }
    )

    assert.strictEqual(extractCalled, false)
    assert.strictEqual(result.datadogContext, undefined)
    assert.strictEqual(result.bodyChecked, true)
  })

  it('extracts trace context from EventBridge body.detail._datadog (EventBridge to SQS)', () => {
    let receivedAttributes
    const plugin = buildPlugin({
      extract: (format, attrs) => {
        receivedAttributes = attrs
        return 'eventbridge-context'
      },
    })

    const datadog = { 'x-datadog-trace-id': '999', 'x-datadog-parent-id': '888', 'x-datadog-sampling-priority': '1' }
    const result = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      { Messages: [{ Body: JSON.stringify(ebEnvelope(datadog)) }] }
    )

    assert.deepStrictEqual(receivedAttributes, datadog)
    assert.strictEqual(result.datadogContext, 'eventbridge-context')
  })

  it('falls through cleanly when an EventBridge envelope has no `_datadog` in detail', () => {
    let extractCalled = false
    const plugin = buildPlugin({
      extract: () => {
        extractCalled = true
        return 'should-not-happen'
      },
    })

    const result = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      { Messages: [{ Body: JSON.stringify(ebEnvelope()) }] }
    )

    assert.strictEqual(extractCalled, false)
    assert.strictEqual(result.datadogContext, undefined)
    assert.strictEqual(result.bodyChecked, true)
  })

  it('extracts trace context from an EventBridge envelope wrapped in an SNS Notification', () => {
    let receivedAttributes
    const plugin = buildPlugin({
      extract: (format, attrs) => {
        receivedAttributes = attrs
        return 'eventbridge-sns-context'
      },
    })

    const datadog = { 'x-datadog-trace-id': '555', 'x-datadog-parent-id': '444' }
    const result = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      { Messages: [{ Body: JSON.stringify(snsWrap(ebEnvelope(datadog))) }] }
    )

    assert.deepStrictEqual(receivedAttributes, datadog)
    assert.strictEqual(result.datadogContext, 'eventbridge-sns-context')
  })

  it('falls through when an SNS Notification Message is not an EventBridge envelope', () => {
    let extractCalled = false
    const plugin = buildPlugin({
      extract: () => {
        extractCalled = true
        return 'should-not-happen'
      },
    })

    const result = plugin.responseExtract(
      { QueueUrl },
      'receiveMessage',
      { Messages: [{ Body: JSON.stringify(snsWrap('a plain string payload, not JSON')) }] }
    )

    assert.strictEqual(extractCalled, false)
    assert.strictEqual(result.datadogContext, undefined)
    assert.strictEqual(result.bodyChecked, true)
  })

  // Both carriers present: MessageAttributes must win and the body is never consulted.
  it('prefers MessageAttributes over the EventBridge body when both are present', () => {
    const extractCalls = []
    const plugin = buildPlugin({
      extract: (format, attrs) => {
        extractCalls.push(attrs)
        return 'message-attribute-context'
      },
    })

    const result = plugin.responseExtract(
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

    assert.strictEqual(result.datadogContext, 'message-attribute-context')
    // extract is called exactly once, with the MessageAttributes context only.
    assert.deepStrictEqual(extractCalls, [{ 'x-datadog-trace-id': 'from-attrs' }])
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
})
