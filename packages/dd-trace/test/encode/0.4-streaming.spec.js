'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const msgpack = require('@msgpack/msgpack')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const constants = require('../../src/constants')
const id = require('../../src/id')
const tags = require('../../../../ext/tags')

const {
  SAMPLING_RULE_DECISION,
  SAMPLING_LIMIT_DECISION,
  SAMPLING_AGENT_DECISION,
  ERROR_MESSAGE,
  ERROR_STACK,
  ERROR_TYPE,
  ORIGIN_KEY,
} = constants

const { MEASURED } = tags

const traceId = id('1234abcd1234abcd')
const spanId = id('1234abcd1234abcd')

// Faithful stand-in for a DatadogSpanContext: the streaming driver and the
// formatter both reach the same way into `getTags()` / `_trace` / `_sampling`,
// so the two encode paths share one source of truth here.
function makeSpan (overrides = {}) {
  const spanTags = overrides.tags ?? {}
  const traceTags = overrides.traceTags ?? {}
  const spanContext = {
    _traceId: traceId,
    _spanId: spanId,
    _parentId: overrides.parentId === undefined ? spanId : overrides.parentId,
    _tags: spanTags,
    _sampling: { priority: overrides.priority },
    _spanSampling: overrides.spanSampling,
    _hostname: overrides.hostname,
    _trace: {
      started: [],
      finished: [],
      tags: traceTags,
      origin: overrides.origin,
      [SAMPLING_RULE_DECISION]: overrides.ruleDecision,
      [SAMPLING_LIMIT_DECISION]: overrides.limitDecision,
      [SAMPLING_AGENT_DECISION]: overrides.agentDecision,
    },
    _name: overrides.name ?? 'operation',
    getTags () { return this._tags },
    getTag (key) { return this._tags[key] },
    setTag (key, value) { this._tags[key] = value },
    hasTag (key) { return key in this._tags },
    toTraceId () { return this._traceId },
    toSpanId () { return this._spanId },
  }

  const span = {
    context: () => spanContext,
    tracer: () => ({ _service: overrides.service ?? 'test' }),
    setTag (key, value) { spanContext._tags[key] = value },
    _startTime: overrides.startTime ?? 1_500_000_000_000.123,
    _duration: overrides.duration ?? 1.234,
    _links: overrides.links,
    _events: overrides.events,
    meta_struct: overrides.metaStruct,
  }

  spanContext._trace.started.push(span)
  return span
}

function linkContext (linkId, overrides = {}) {
  return {
    toTraceId: () => linkId,
    toSpanId: () => linkId,
    _tracestate: overrides.tracestate,
    _sampling: overrides.sampling ?? {},
  }
}

// Shared so both encode paths see the identical stack string; a fresh
// `new TypeError()` per build would capture different stack line numbers and
// diverge on the `error.stack` meta value for reasons unrelated to encoding.
const sharedError = new TypeError('kaboom')

const matrix = {
  'minimal span': () => makeSpan(),
  'http server root span': () => makeSpan({
    parentId: null,
    priority: 1,
    ruleDecision: 1,
    tags: {
      'service.name': 'svc',
      'span.type': 'web',
      'resource.name': 'GET /users/:id',
      'span.kind': 'server',
      'http.method': 'GET',
      'http.url': 'https://example.com/users/42',
      'http.route': '/users/:id',
      component: 'express',
      'http.status_code': 200,
      'http.response.content_length': 4096,
    },
    traceTags: { '_dd.p.dm': '-0', '_dd.p.tid': '671d3c4500000000' },
  }),
  'error span via error tags': () => makeSpan({
    tags: {
      [ERROR_TYPE]: 'TypeError',
      [ERROR_MESSAGE]: 'boom',
      [ERROR_STACK]: 'TypeError: boom\n    at <anonymous>',
    },
  }),
  'error span via Error object': () => makeSpan({
    tags: { error: sharedError },
  }),
  'mixed value tags': () => makeSpan({
    tags: {
      'analytics.event': true,
      [MEASURED]: 1,
      stringTag: 'value',
      numberTag: 42.5,
      boolTag: false,
      nanTag: Number.NaN,
      nested: { a: 1, b: 'two' },
    },
  }),
  'span with links': () => makeSpan({
    links: [
      { context: linkContext(spanId.toString()), attributes: { reason: 'follows' } },
      { context: linkContext(spanId.toString()) },
    ],
  }),
  'span with link flags and tracestate': () => makeSpan({
    links: [
      {
        context: linkContext(spanId.toString(), {
          sampling: { priority: 1 },
          tracestate: { toString: () => 'dd=s:1;o:rum' },
        }),
        attributes: { reason: 'follows' },
      },
      { context: linkContext(spanId.toString(), { sampling: { priority: 0 } }) },
    ],
  }),
  'span with events': () => makeSpan({
    events: [
      { name: 'first', startTime: 1 },
      { name: 'second', attributes: { emotion: 'happy', rating: 9.8 }, startTime: 1633023102 },
    ],
  }),
  'span with origin and hostname': () => makeSpan({
    origin: 'synthetics',
    hostname: 'web-01',
    priority: 2,
  }),
  'single-span ingestion': () => makeSpan({
    spanSampling: { sampleRate: 0.5, maxPerSecond: 100 },
  }),
  'span with meta_struct': () => makeSpan({
    metaStruct: { 'appsec.events': { rule: 'test', matches: [1, 2] } },
  }),
  // A start below 2^32 skips the fused-u64 head tail (the rare synthetic case).
  'span with sub-2^32 start': () => makeSpan({ startTime: 1000 }),
  // The span.kind default and an explicit _dd.measured tag both target the same
  // metric; the walkSpan guard keeps it single-emit so the byte path stays
  // identical to the object path here too.
  'explicit _dd.measured override on a kind span': () => makeSpan({
    tags: { 'span.kind': 'server', [MEASURED]: 0 },
  }),
}

// Pathological spans where a user tag shadows a reserved key the formatter also
// writes. The object path collapses to one entry; the forward-only byte path
// emits both and relies on the agent's last-write-wins decode. The wire bytes
// differ, but the decoded span is identical — the contract the agent enforces.
const decodeMatrix = {
  'user tag shadowing language': () => makeSpan({
    tags: { 'span.kind': 'server', language: 'klingon' },
  }),
  'user tag shadowing origin': () => makeSpan({
    origin: 'synthetics',
    tags: { [ORIGIN_KEY]: 'user-supplied' },
  }),
}

function loadEncoder ({ debug = false, nativeSpanEvents = false } = {}) {
  const logger = { debug: sinon.stub() }
  const getConfig = () => ({
    DD_TRACE_NATIVE_SPAN_EVENTS: nativeSpanEvents,
    DD_TRACE_ENCODING_DEBUG: debug,
  })
  const { AgentEncoder } = proxyquire('../../src/encode/0.4', {
    '../log': logger,
    '../config': getConfig,
  })
  return { AgentEncoder, logger }
}

function buildEncoders (nativeSpanEvents) {
  const { AgentEncoder } = loadEncoder({ nativeSpanEvents })
  const objectEncoder = new AgentEncoder({ flush: sinon.spy() })
  const streamingEncoder = new AgentEncoder({ flush: sinon.spy() })
  return { objectEncoder, streamingEncoder }
}

describe('encode 0.4 streaming byte-equality', () => {
  let format

  beforeEach(() => {
    format = require('../../src/span_format')
  })

  for (const nativeSpanEvents of [false, true]) {
    describe(`DD_TRACE_NATIVE_SPAN_EVENTS=${nativeSpanEvents}`, () => {
      for (const [label, build] of Object.entries(matrix)) {
        it(`produces byte-identical 0.4 output for ${label}`, () => {
          const { objectEncoder, streamingEncoder } = buildEncoders(nativeSpanEvents)

          const objectSpan = build()
          objectEncoder.encode([format(objectSpan, true, false)])
          const objectBytes = objectEncoder.makePayload()

          const streamingSpan = build()
          streamingEncoder.encodeRaw([streamingSpan], false)
          const streamingBytes = streamingEncoder.makePayload()

          assert.deepStrictEqual(streamingBytes, objectBytes)
        })
      }

      for (const [label, build] of Object.entries(decodeMatrix)) {
        it(`produces decode-identical 0.4 output for ${label}`, () => {
          const { objectEncoder, streamingEncoder } = buildEncoders(nativeSpanEvents)

          objectEncoder.encode([format(build(), true, false)])
          const objectDecoded = msgpack.decode(objectEncoder.makePayload(), { useBigInt64: true })

          streamingEncoder.encodeRaw([build()], false)
          const streamingDecoded = msgpack.decode(streamingEncoder.makePayload(), { useBigInt64: true })

          assert.deepStrictEqual(streamingDecoded, objectDecoded)
        })
      }
    })
  }

  it('flushes when the trace buffer passes the soft limit', () => {
    const { AgentEncoder } = loadEncoder()
    const flush = sinon.spy()
    const encoder = new AgentEncoder({ flush }, 256)

    encoder.encodeRaw([matrix['http server root span']()], false)

    assert.ok(flush.called)
  })

  it('logs the encoded buffer when encoding debug is on', () => {
    const { AgentEncoder, logger } = loadEncoder({ debug: true })
    const encoder = new AgentEncoder({ flush: sinon.spy() })

    encoder.encodeRaw([makeSpan()], false)

    assert.ok(logger.debug.called)
  })
})
