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

const datadogAttribute = datadog => ({
  MessageAttributes: { _datadog: { DataType: 'String', StringValue: JSON.stringify(datadog) } },
})

describe('Sqs plugin startResponseSpan', () => {
  // Drives the real `responseExtract` carrier parsing while stubbing only the span machinery the
  // base class would otherwise provide, so the parent/link wiring is asserted without a broker.
  function runReceive ({ messages, consumerEnabled = true, operation = 'receiveMessage' }) {
    const startSpanCalls = []
    const linkedContexts = []
    const span = { addLink: ({ context }) => linkedContexts.push(context) }

    const plugin = buildPlugin({
      // Tag each extracted context with its carrier so the parent and links stay distinguishable.
      extract: (format, carrier) => ({ context: carrier }),
    })
    plugin._parentMap = new WeakMap()
    plugin.requestTags = new WeakMap()
    plugin.startSpan = (name, options, ctx) => {
      startSpanCalls.push({ name, options })
      ctx.currentStore = { span }
      return span
    }

    const request = { params: { QueueUrl }, operation }
    const parentStore = { span: 'parent' }
    plugin._parentMap.set(request, parentStore)
    if (consumerEnabled) {
      plugin.requestTags.set(request, { 'aws.operation': operation, component: 'aws-sdk' })
    }

    const ctx = { request, response: { Messages: messages } }
    const store = plugin.startResponseSpan(ctx)
    return { ctx, store, parentStore, startSpanCalls, linkedContexts }
  }

  it('makes the first message the parent and links every additional message', () => {
    const first = { 'x-datadog-trace-id': '1' }
    const second = { 'x-datadog-trace-id': '2' }
    const third = { 'x-datadog-trace-id': '3' }

    const result = runReceive({
      messages: [datadogAttribute(first), datadogAttribute(second), datadogAttribute(third)],
    })

    assert.strictEqual(result.startSpanCalls.length, 1)
    assert.strictEqual(result.startSpanCalls[0].name, 'aws.response')
    assert.deepStrictEqual(result.startSpanCalls[0].options.childOf, { context: first })
    assert.strictEqual(result.startSpanCalls[0].options.meta['span.kind'], 'server')
    assert.deepStrictEqual(result.linkedContexts, [{ context: second }, { context: third }])
    assert.strictEqual(result.ctx.needsFinish, true)
    assert.strictEqual(result.store, result.ctx.currentStore)
  })

  it('creates a parent-only span with no links for a single message', () => {
    const only = { 'x-datadog-trace-id': '9' }

    const result = runReceive({ messages: [datadogAttribute(only)] })

    assert.strictEqual(result.startSpanCalls.length, 1)
    assert.deepStrictEqual(result.startSpanCalls[0].options.childOf, { context: only })
    assert.deepStrictEqual(result.linkedContexts, [])
  })

  it('skips messages without a carrier when choosing the parent and links', () => {
    const first = { 'x-datadog-trace-id': '1' }
    const third = { 'x-datadog-trace-id': '3' }

    const result = runReceive({
      messages: [datadogAttribute(first), { Body: 'no context', MessageAttributes: {} }, datadogAttribute(third)],
    })

    assert.deepStrictEqual(result.startSpanCalls[0].options.childOf, { context: first })
    assert.deepStrictEqual(result.linkedContexts, [{ context: third }])
  })

  it('creates no span and keeps the parent store when the consumer is disabled', () => {
    const result = runReceive({ messages: [datadogAttribute({ 'x-datadog-trace-id': '1' })], consumerEnabled: false })

    assert.strictEqual(result.startSpanCalls.length, 0)
    assert.strictEqual(result.store, result.parentStore)
    assert.notStrictEqual(result.ctx.needsFinish, true)
  })

  it('creates no span when no received message carries trace context', () => {
    const result = runReceive({ messages: [{ Body: 'plain', MessageAttributes: {} }] })

    assert.strictEqual(result.startSpanCalls.length, 0)
    assert.strictEqual(result.store, result.parentStore)
  })

  it('creates no span for a non-receive response', () => {
    const result = runReceive({ messages: [datadogAttribute({ 'x-datadog-trace-id': '1' })], operation: 'sendMessage' })

    assert.strictEqual(result.startSpanCalls.length, 0)
    assert.strictEqual(result.store, result.parentStore)
  })
})
