'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const BaseAwsSdkPlugin = require('../../../packages/datadog-plugin-aws-sdk/src/base')
const EventBridge = require('../../../packages/datadog-plugin-aws-sdk/src/services/eventbridge')
const Lambda = require('../../../packages/datadog-plugin-aws-sdk/src/services/lambda')

const { VARIANT } = process.env

const OPERATIONS = Number(process.env.OPERATIONS)

// Plugin reads `this.tracer` via a getter that forwards to `this._tracer`; wire the
// stub through the underscore field so the public access path stays intact.
const fakeSpan = {}
const fakeTracer = {
  inject (span, format, carrier) {
    carrier['x-datadog-trace-id'] = '1234567890'
    carrier['x-datadog-parent-id'] = '987654321'
    carrier['x-datadog-sampling-priority'] = '1'
    carrier['x-datadog-tags'] = '_dd.p.dm=-1,_dd.p.tid=1234567890abcdef'
  },
}

const RESPONSE = {
  $metadata: { httpStatusCode: 200, requestId: 'req-aaaaaaaaaa', attempts: 1, totalRetryDelay: 0 },
  request: { operation: 'sendMessage', params: {} },
  requestId: 'req-aaaaaaaaaa',
  ResponseMetadata: { RequestId: 'req-bbbbbbbbbb' },
  MessageId: 'msg-cccccccccc',
  SequenceNumber: '987654321',
  Messages: [{ MessageId: 'msg-1', Body: 'payload-1' }, { MessageId: 'msg-2', Body: 'payload-2' }],
  Body: 'payload-top',
}

const EVENTBRIDGE_DETAIL_JSON = JSON.stringify({
  orderId: 'order-1234567890',
  customerId: 'cust-987654321',
  items: 5,
  total: 1234.56,
  currency: 'USD',
  region: 'us-east-1',
})

guard.loopStart()
// Read a field of every result into `sink` so V8 can't dead-code-eliminate the
// measured call; asserted non-zero after the loop.
let sink = 0
if (VARIANT === 'extract-response-body') {
  const plugin = Object.create(BaseAwsSdkPlugin.prototype)
  // Pre-flight: confirm extractResponseBody strips the SDK envelope keys; catches
  // a silent breakage where the response shape no longer matches the function.
  const sanityBody = plugin.extractResponseBody(RESPONSE)
  assert.equal(sanityBody.$metadata, undefined)
  assert.equal(sanityBody.MessageId, 'msg-cccccccccc')
  for (let iteration = 0; iteration < OPERATIONS; iteration++) {
    sink += plugin.extractResponseBody(RESPONSE).MessageId.length
  }
} else if (VARIANT === 'eventbridge-inject-detail') {
  const plugin = Object.create(EventBridge.prototype)
  plugin._tracer = fakeTracer
  const sanityRequest = {
    operation: 'putEvents',
    params: { Entries: [{ Detail: EVENTBRIDGE_DETAIL_JSON }] },
  }
  plugin.requestInject(fakeSpan, sanityRequest)
  assert.ok(sanityRequest.params.Entries[0].Detail.includes('_datadog'),
    'EventBridge requestInject did not embed _datadog')
  for (let iteration = 0; iteration < OPERATIONS; iteration++) {
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: EVENTBRIDGE_DETAIL_JSON }] },
    }
    plugin.requestInject(fakeSpan, request)
    sink += request.params.Entries[0].Detail.length
  }
} else if (VARIANT === 'lambda-inject-no-context') {
  const plugin = Object.create(Lambda.prototype)
  plugin._tracer = fakeTracer
  const sanityRequest = { operation: 'invoke', params: { FunctionName: 'my-fn' } }
  plugin.requestInject(fakeSpan, sanityRequest)
  assert.ok(sanityRequest.params.ClientContext, 'Lambda requestInject did not set ClientContext')
  for (let iteration = 0; iteration < OPERATIONS; iteration++) {
    const request = { operation: 'invoke', params: { FunctionName: 'my-fn' } }
    plugin.requestInject(fakeSpan, request)
    sink += request.params.ClientContext.length
  }
} else if (VARIANT === 'lambda-inject-with-context') {
  // The heavier real-world Lambda path: an existing ClientContext carrying a `custom`
  // block, so requestInject base64-decodes it, JSON.parses, Object.assigns the injected
  // trace keys into custom, then re-stringifies and re-encodes -- exercising the
  // try/catch around the JSON ops that the no-context path never reaches.
  const plugin = Object.create(Lambda.prototype)
  plugin._tracer = fakeTracer
  const EXISTING_CONTEXT = Buffer.from(
    JSON.stringify({ custom: { 'app.request.id': 'req-1234567890' } })
  ).toString('base64')
  const sanityRequest = {
    operation: 'invoke',
    params: { FunctionName: 'my-fn', ClientContext: EXISTING_CONTEXT },
  }
  plugin.requestInject(fakeSpan, sanityRequest)
  const merged = JSON.parse(Buffer.from(sanityRequest.params.ClientContext, 'base64').toString('utf8'))
  assert.ok(merged.custom['app.request.id'] === 'req-1234567890' && merged.custom['x-datadog-trace-id'],
    'Lambda requestInject did not merge datadog keys into the existing ClientContext')
  for (let iteration = 0; iteration < OPERATIONS; iteration++) {
    const request = {
      operation: 'invoke',
      params: { FunctionName: 'my-fn', ClientContext: EXISTING_CONTEXT },
    }
    plugin.requestInject(fakeSpan, request)
    sink += request.params.ClientContext.length
  }
}
guard.done()

if (sink === 0) throw new Error('unreachable')
