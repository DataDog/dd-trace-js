'use strict'

const assert = require('node:assert/strict')

const BaseAwsSdkPlugin = require('../../../packages/datadog-plugin-aws-sdk/src/base')
const EventBridge = require('../../../packages/datadog-plugin-aws-sdk/src/services/eventbridge')
const Lambda = require('../../../packages/datadog-plugin-aws-sdk/src/services/lambda')
const {
  extractTextAndResponseReason,
} = require('../../../packages/datadog-plugin-aws-sdk/src/services/bedrockruntime/utils')

const { VARIANT } = process.env

const ITERATIONS = 2_000_000

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

// Eight realistic AWS service response shapes for the megamorphic
// `addResponseTags` bench. The variant cycles through them so V8 keeps
// multiple hidden classes the way production sees them.
const RESPONSE_SHAPES = [
  { request: { params: {}, operation: 'scan' }, requestId: 'r-ddb', Items: [], Count: 0, ScannedCount: 0 },
  { request: { params: {}, operation: 'putRecords' }, requestId: 'r-kin',
    Records: [{ data: 'a' }, { data: 'b' }], FailedRecordCount: 0 },
  { request: { params: {}, operation: 'receiveMessage' }, requestId: 'r-sqs',
    Messages: [{ body: 'm' }], NextReceiptHandle: 'h' },
  { request: { params: {}, operation: 'listBuckets' }, requestId: 'r-s3',
    Buckets: [{ Name: 'x' }, { Name: 'y' }], Owner: { ID: 'o' } },
  { request: { params: {}, operation: 'publish' }, requestId: 'r-sns',
    MessageId: 'mid', SequenceNumber: '0' },
  { request: { params: {}, operation: 'invoke' }, requestId: 'r-lambda',
    FunctionError: undefined, ExecutedVersion: '$LATEST', Payload: '{}' },
  { request: { params: {}, operation: 'createSubscription' }, requestId: 'r-pubsub',
    Subscription: { Name: 'sub' }, Topic: 'topic' },
  { request: { params: {}, operation: 'getItem' }, requestId: 'r-ddb',
    Item: { id: { S: '1' }, name: { S: 'a' } }, ConsumedCapacity: { TableName: 't', CapacityUnits: 0.5 } },
]

const EVENTBRIDGE_DETAIL_JSON = JSON.stringify({
  orderId: 'order-1234567890',
  customerId: 'cust-987654321',
  items: 5,
  total: 1234.56,
  currency: 'USD',
  region: 'us-east-1',
})

if (VARIANT === 'extract-response-body') {
  const plugin = Object.create(BaseAwsSdkPlugin.prototype)
  // Pre-flight: confirm extractResponseBody strips the SDK envelope keys; catches
  // a silent breakage where the response shape no longer matches the function.
  const sanityBody = plugin.extractResponseBody(RESPONSE)
  assert.equal(sanityBody.$metadata, undefined)
  assert.equal(sanityBody.MessageId, 'msg-cccccccccc')
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    plugin.extractResponseBody(RESPONSE)
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
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const request = {
      operation: 'putEvents',
      params: { Entries: [{ Detail: EVENTBRIDGE_DETAIL_JSON }] },
    }
    plugin.requestInject(fakeSpan, request)
  }
} else if (VARIANT === 'lambda-inject-no-context') {
  const plugin = Object.create(Lambda.prototype)
  plugin._tracer = fakeTracer
  const sanityRequest = { operation: 'invoke', params: { FunctionName: 'my-fn' } }
  plugin.requestInject(fakeSpan, sanityRequest)
  assert.ok(sanityRequest.params.ClientContext, 'Lambda requestInject did not set ClientContext')
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const request = { operation: 'invoke', params: { FunctionName: 'my-fn' } }
    plugin.requestInject(fakeSpan, request)
  }
} else if (VARIANT === 'add-response-tags') {
  // The plugin work per call is tiny (build a 3-key literal + dispatch), so the
  // inner loop runs ~15x more iterations than the other variants to land in the
  // ~1-3 s sirun target band.
  const innerIterations = ITERATIONS * 15
  // Span stub mirrors the production `addTags` shape (iterate keys, call
  // `setTag` per entry). Storing into a `Map` keeps the iteration observable
  // so V8 cannot DCE the per-call `tags` literal the plugin builds, and the
  // map is keyed by stable tag names so it never grows past a handful of
  // entries.
  const observedTags = new Map()
  const span = {
    addTags (tags) {
      for (const key of Object.keys(tags)) observedTags.set(key, tags[key])
    },
    setTag (key, value) {
      observedTags.set(key, value)
    },
  }
  const plugin = Object.create(BaseAwsSdkPlugin.prototype)
  plugin._tracerConfig = {}
  plugin.generateTags = () => undefined

  // Pre-flight: confirm the plugin actually walks the tag-building path on a
  // representative shape; catches a silent breakage where the response no
  // longer matches what `addResponseTags` reads.
  plugin.addResponseTags(span, RESPONSE_SHAPES[0])
  assert.equal(observedTags.get('span.kind'), 'client',
    'addResponseTags did not write the span.kind tag')

  const len = RESPONSE_SHAPES.length
  for (let iteration = 0; iteration < innerIterations; iteration++) {
    plugin.addResponseTags(span, RESPONSE_SHAPES[iteration % len])
  }
} else if (VARIANT === 'bedrock-extract-text') {
  // Realistic Amazon Titan response payload as a Buffer; the bench measures the
  // `Buffer.from(response.body).toString('utf8')` decode + JSON.parse + provider
  // switch on every Bedrock invocation.
  const PAYLOAD = Buffer.from(JSON.stringify({
    inputTextTokenCount: 10,
    results: [
      {
        outputText: 'Hello world from a synthetic Bedrock response. '.repeat(20),
        completionReason: 'FINISH',
        tokenCount: 50,
      },
    ],
  }))
  const RESPONSE_BEDROCK = { body: PAYLOAD }

  const generation = extractTextAndResponseReason(RESPONSE_BEDROCK, 'AMAZON', 'titan-text-express-v1')
  assert.ok(generation.message.length > 0,
    'extractTextAndResponseReason did not produce a non-empty message')

  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    extractTextAndResponseReason(RESPONSE_BEDROCK, 'AMAZON', 'titan-text-express-v1')
  }
}
