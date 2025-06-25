'use strict'

const t = require('tap')
require('../setup/core')

const { expect } = require('chai')
const msgpack = require('@msgpack/msgpack')
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

t.test('agentless-ci-visibility-encode', t => {
  let encoder
  let writer
  let logger
  let trace

  t.beforeEach(() => {
    logger = {
      debug: sinon.stub()
    }
    const { AgentlessCiVisibilityEncoder } = proxyquire('../src/encode/agentless-ci-visibility', {
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

  t.test('should encode to msgpack', t => {
    encoder.encode(trace)

    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { useBigInt64: true })

    expect(decodedTrace.version).to.equal(1)
    expect(decodedTrace.metadata['*']).to.contain({
      language: 'javascript',
      library_version: ddTraceVersion
    })
    const spanEvent = decodedTrace.events[0]
    expect(spanEvent.type).to.equal('span')
    expect(spanEvent.version).to.equal(1)
    expect(spanEvent.content.trace_id.toString(10)).to.equal(trace[0].trace_id.toString(10))
    expect(spanEvent.content.span_id.toString(10)).to.equal(trace[0].span_id.toString(10))
    expect(spanEvent.content.parent_id.toString(10)).to.equal(trace[0].parent_id.toString(10))
    expect(spanEvent.content).to.contain({
      name: 'test',
      resource: 'test-r',
      service: 'test-s',
      type: 'foo'
    })
    expect(spanEvent.content.error).to.equal(0)
    expect(spanEvent.content.start).to.equal(123)
    expect(spanEvent.content.duration).to.equal(456)

    expect(spanEvent.content.meta).to.eql({
      bar: 'baz'
    })
    expect(spanEvent.content.metrics).to.contain({
      float: 1.23456712345,
      negativefloat: -1.23456789,
      bigfloat: 12345678.9,
      bignegativefloat: -12345678.9
    })

    expect(spanEvent.content.metrics.positive).to.equal(123456712345)
    expect(spanEvent.content.metrics.negative).to.equal(-123456712345)
    t.end()
  })

  t.test('should report its count', t => {
    expect(encoder.count()).to.equal(0)

    encoder.encode(trace)

    expect(encoder.count()).to.equal(1)

    encoder.encode(trace)

    expect(encoder.count()).to.equal(2)
    t.end()
  })

  t.test('should reset after making a payload', t => {
    encoder.encode(trace)
    encoder.makePayload()

    expect(encoder.count()).to.equal(0)
    t.end()
  })

  t.test('should truncate name, service, type and resource when they are too long', t => {
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

    expect(decodedTrace)
    const spanEvent = decodedTrace.events[0]
    expect(spanEvent.content.type.length).to.equal(MAX_TYPE_LENGTH)
    expect(spanEvent.content.name.length).to.equal(MAX_NAME_LENGTH)
    expect(spanEvent.content.service.length).to.equal(MAX_SERVICE_LENGTH)
    // ellipsis is added
    expect(spanEvent.content.resource.length).to.equal(MAX_RESOURCE_NAME_LENGTH + 3)
    t.end()
  })

  t.test('should fallback to a default name and service if they are not present', t => {
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

    expect(decodedTrace)
    const spanEvent = decodedTrace.events[0]
    expect(spanEvent.content.service).to.equal(DEFAULT_SERVICE_NAME)
    expect(spanEvent.content.name).to.equal(DEFAULT_SPAN_NAME)
    t.end()
  })

  t.test('should cut too long meta and metrics keys and meta values', t => {
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
    expect(spanEvent.content.meta).to.eql({
      [`${tooLongKey.slice(0, MAX_META_KEY_LENGTH)}...`]: `${tooLongValue.slice(0, MAX_META_VALUE_LENGTH)}...`
    })
    expect(spanEvent.content.metrics).to.eql({
      [`${tooLongKey.slice(0, MAX_METRIC_KEY_LENGTH)}...`]: 15
    })
    t.end()
  })

  t.test('should not encode events other than sessions and suites if the trace is a test session', t => {
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
    expect(decodedTrace.events.length).to.equal(1)
    expect(decodedTrace.events[0].type).to.equal('test_session_end')
    expect(decodedTrace.events[0].content.type).to.eql('test_session_end')
    t.end()
  })

  t.test('does not crash if test_session_id is in meta but not test_module_id', t => {
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
    expect(spanEvent.type).to.equal('span')
    expect(spanEvent.version).to.equal(1)
    t.end()
  })

  t.test('addMetadataTags', t => {
    t.afterEach(() => {
      encoder.metadataTags = {}
    })

    t.test('should add simple metadata tags', t => {
      const tags = {
        test: { tag: 'value1' },
        test_session_end: { tag: 'value2' }
      }
      encoder.addMetadataTags(tags)
      expect(encoder.metadataTags).to.eql(tags)
      t.end()
    })

    t.test('should merge dictionaries if there are values already', t => {
      encoder.metadataTags = {
        test: { tag: 'value1' }
      }
      const tags = {
        test: { other: 'value2' },
        test_session_end: { tag: 'value3' }
      }
      encoder.addMetadataTags(tags)
      expect(encoder.metadataTags).to.eql({
        test: { tag: 'value1', other: 'value2' },
        test_session_end: { tag: 'value3' }
      })
      t.end()
    })

    t.test('should handle empty tags', t => {
      encoder.metadataTags = { test: { tag: 'value1' } }
      encoder.addMetadataTags({})
      expect(encoder.metadataTags).to.eql({ test: { tag: 'value1' } })
      t.end()
    })
    t.end()
  })
  t.end()
})
