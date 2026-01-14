'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const msgpack = require('@msgpack/msgpack')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
require('../setup/core')
const id = require('../../src/id')

const {
  MAX_META_KEY_LENGTH,
  MAX_META_VALUE_LENGTH,
  MAX_METRIC_KEY_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SERVICE_LENGTH,
  MAX_RESOURCE_NAME_LENGTH,
  MAX_TYPE_LENGTH,
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME
} = require('../../src/encode/tags-processors')

const { version: ddTraceVersion } = require('../../../../package.json')

describe('agentless-ci-visibility-encode', () => {
  let encoder
  let writer
  let logger
  let trace

  beforeEach(() => {
    logger = {
      debug: sinon.stub()
    }
    const { AgentlessCiVisibilityEncoder } = proxyquire('../../src/encode/agentless-ci-visibility', {
      '../log': logger
    })
    writer = { flush: sinon.spy() }
    encoder = new AgentlessCiVisibilityEncoder(writer, {})

    trace = [{
      trace_id: id('1234abcd1234abcd'),
      span_id: id('1234abcd1234abcd'),
      parent_id: id('1234abcd1234abcd'),
      name: 'test',
      resource: 'test-r',
      service: 'test-s',
      type: 'foo',
      error: 0,
      meta: {
        bar: 'baz'
      },
      metrics: {
        positive: 123456712345,
        negative: -123456712345,
        float: 1.23456712345,
        negativefloat: -1.23456789,
        bigfloat: 12345678.9,
        bignegativefloat: -12345678.9
      },
      start: 123,
      duration: 456
    }]
  })

  it('should encode to msgpack', () => {
    encoder.encode(trace)

    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { useBigInt64: true })

    assert.strictEqual(decodedTrace.version, 1)
    assertObjectContains(decodedTrace.metadata['*'], {
      language: 'javascript',
      library_version: ddTraceVersion
    })
    const spanEvent = decodedTrace.events[0]
    assert.strictEqual(spanEvent.type, 'span')
    assert.strictEqual(spanEvent.version, 1)
    assert.strictEqual(spanEvent.content.trace_id.toString(10), trace[0].trace_id.toString(10))
    assert.strictEqual(spanEvent.content.span_id.toString(10), trace[0].span_id.toString(10))
    assert.strictEqual(spanEvent.content.parent_id.toString(10), trace[0].parent_id.toString(10))
    assertObjectContains(spanEvent.content, {
      name: 'test',
      resource: 'test-r',
      service: 'test-s',
      type: 'foo'
    })
    assert.strictEqual(spanEvent.content.error, 0)
    assert.strictEqual(spanEvent.content.start, 123)
    assert.strictEqual(spanEvent.content.duration, 456)

    assert.deepStrictEqual(spanEvent.content.meta, {
      bar: 'baz'
    })
    assertObjectContains(spanEvent.content.metrics, {
      float: 1.23456712345,
      negativefloat: -1.23456789,
      bigfloat: 12345678.9,
      bignegativefloat: -12345678.9
    })

    assert.strictEqual(spanEvent.content.metrics.positive, 123456712345)
    assert.strictEqual(spanEvent.content.metrics.negative, -123456712345)
  })

  it('should report its count', () => {
    assert.strictEqual(encoder.count(), 0)

    encoder.encode(trace)

    assert.strictEqual(encoder.count(), 1)

    encoder.encode(trace)

    assert.strictEqual(encoder.count(), 2)
  })

  it('should reset after making a payload', () => {
    encoder.encode(trace)
    encoder.makePayload()

    assert.strictEqual(encoder.count(), 0)
  })

  it('should truncate name, service, type and resource when they are too long', () => {
    const tooLongString = new Array(500).fill('a').join('')
    const resourceTooLongString = new Array(10000).fill('a').join('')
    const traceToTruncate = [{
      trace_id: id('1234abcd1234abcd'),
      span_id: id('1234abcd1234abcd'),
      parent_id: id('1234abcd1234abcd'),
      error: 0,
      meta: {
        bar: 'baz'
      },
      metrics: {},
      name: tooLongString,
      resource: resourceTooLongString,
      type: tooLongString,
      service: tooLongString,
      start: 123,
      duration: 456
    }]
    encoder.encode(traceToTruncate)

    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { useBigInt64: true })

    assert.ok(decodedTrace)
    const spanEvent = decodedTrace.events[0]
    assert.strictEqual(spanEvent.content.type.length, MAX_TYPE_LENGTH)
    assert.strictEqual(spanEvent.content.name.length, MAX_NAME_LENGTH)
    assert.strictEqual(spanEvent.content.service.length, MAX_SERVICE_LENGTH)
    // ellipsis is added
    assert.strictEqual(spanEvent.content.resource.length, MAX_RESOURCE_NAME_LENGTH + 3)
  })

  it('should fallback to a default name and service if they are not present', () => {
    const traceToTruncate = [{
      trace_id: id('1234abcd1234abcd'),
      span_id: id('1234abcd1234abcd'),
      parent_id: id('1234abcd1234abcd'),
      error: 0,
      meta: {
        bar: 'baz'
      },
      metrics: {},
      resource: 'resource',
      start: 123,
      duration: 456
    }]
    encoder.encode(traceToTruncate)

    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { useBigInt64: true })

    assert.ok(decodedTrace)
    const spanEvent = decodedTrace.events[0]
    assert.strictEqual(spanEvent.content.service, DEFAULT_SERVICE_NAME)
    assert.strictEqual(spanEvent.content.name, DEFAULT_SPAN_NAME)
  })

  it('should cut too long meta and metrics keys and meta values', () => {
    const tooLongKey = new Array(300).fill('a').join('')
    const tooLongValue = new Array(26000).fill('a').join('')
    const traceToTruncate = [{
      trace_id: id('1234abcd1234abcd'),
      span_id: id('1234abcd1234abcd'),
      parent_id: id('1234abcd1234abcd'),
      error: 0,
      meta: {
        [tooLongKey]: tooLongValue
      },
      metrics: {
        [tooLongKey]: 15
      },
      start: 123,
      duration: 456,
      type: 'foo',
      name: '',
      resource: '',
      service: ''
    }]
    encoder.encode(traceToTruncate)

    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { useBigInt64: true })
    const spanEvent = decodedTrace.events[0]
    assert.deepStrictEqual(spanEvent.content.meta, {
      [`${tooLongKey.slice(0, MAX_META_KEY_LENGTH)}...`]: `${tooLongValue.slice(0, MAX_META_VALUE_LENGTH)}...`
    })
    assert.deepStrictEqual(spanEvent.content.metrics, {
      [`${tooLongKey.slice(0, MAX_METRIC_KEY_LENGTH)}...`]: 15
    })
  })

  it('should not encode events other than sessions and suites if the trace is a test session', () => {
    const traceToFilter = [
      {
        trace_id: id('1234abcd1234abcd'),
        span_id: id('1234abcd1234abcd'),
        parent_id: id('1234abcd1234abcd'),
        error: 0,
        meta: {},
        metrics: {},
        start: 123,
        duration: 456,
        type: 'test_session_end',
        name: '',
        resource: '',
        service: ''
      },
      {
        trace_id: id('1234abcd1234abcd'),
        span_id: id('1234abcd1234abcd'),
        parent_id: id('1234abcd1234abcd'),
        error: 0,
        meta: {},
        metrics: {},
        start: 123,
        duration: 456,
        type: 'http',
        name: '',
        resource: '',
        service: ''
      }
    ]

    encoder.encode(traceToFilter)

    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { useBigInt64: true })
    assert.strictEqual(decodedTrace.events.length, 1)
    assert.strictEqual(decodedTrace.events[0].type, 'test_session_end')
    assert.deepStrictEqual(decodedTrace.events[0].content.type, 'test_session_end')
  })

  it('does not crash if test_session_id is in meta but not test_module_id', () => {
    const traceToTruncate = [{
      trace_id: id('1234abcd1234abcd'),
      span_id: id('1234abcd1234abcd'),
      parent_id: id('1234abcd1234abcd'),
      error: 0,
      meta: {
        test_session_id: '1234abcd1234abcd'
      },
      metrics: {},
      start: 123,
      duration: 456,
      type: 'foo',
      name: '',
      resource: '',
      service: ''
    }]
    encoder.encode(traceToTruncate)
    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { useBigInt64: true })
    const spanEvent = decodedTrace.events[0]
    assert.strictEqual(spanEvent.type, 'span')
    assert.strictEqual(spanEvent.version, 1)
  })

  describe('addMetadataTags', () => {
    afterEach(() => {
      encoder.metadataTags = {}
    })

    it('should add simple metadata tags', () => {
      const tags = {
        test: { tag: 'value1' },
        test_session_end: { tag: 'value2' }
      }
      encoder.addMetadataTags(tags)
      assert.deepStrictEqual(encoder.metadataTags, tags)
    })

    it('should merge dictionaries if there are values already', () => {
      encoder.metadataTags = {
        test: { tag: 'value1' }
      }
      const tags = {
        test: { other: 'value2' },
        test_session_end: { tag: 'value3' }
      }
      encoder.addMetadataTags(tags)
      assert.deepStrictEqual(encoder.metadataTags, {
        test: { tag: 'value1', other: 'value2' },
        test_session_end: { tag: 'value3' }
      })
    })

    it('should handle empty tags', () => {
      encoder.metadataTags = { test: { tag: 'value1' } }
      encoder.addMetadataTags({})
      assert.deepStrictEqual(encoder.metadataTags, { test: { tag: 'value1' } })
    })
  })
})
