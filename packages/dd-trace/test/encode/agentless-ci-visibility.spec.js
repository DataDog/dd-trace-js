'use strict'

const { expect } = require('chai')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const id = require('../../src/id')
const {
  MAX_META_KEY_LENGTH,
  MAX_META_VALUE_LENGTH,
  MAX_METRIC_KEY_LENGTH,
  MAX_METRIC_VALUE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SERVICE_LENGTH,
  MAX_RESOURCE_NAME_LENGTH,
  MAX_TYPE_LENGTH,
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME
} = require('../../src/encode/tags-processors')

describe('agentless-ci-visibility-encode', () => {
  let encoder
  let writer
  let logger
  let trace

  beforeEach(() => {
    logger = {
      debug: sinon.stub()
    }
    const { AgentlessCiVisibilityEncoder } = proxyquire('../src/encode/agentless-ci-visibility', {
      '../log': logger
    })
    writer = { flush: sinon.spy() }
    encoder = new AgentlessCiVisibilityEncoder(writer)

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
    const decodedTrace = msgpack.decode(buffer, { codec })

    expect(decodedTrace.version.toNumber()).to.equal(1)
    expect(decodedTrace.metadata).to.contain({
      language: 'javascript',
      'runtime.name': 'node',
      'runtime.version':
      process.version
    })
    const spanEvent = decodedTrace.events[0]
    expect(spanEvent.type).to.equal('span')
    expect(spanEvent.version.toNumber()).to.equal(1)
    expect(spanEvent.content.trace_id.toString(10)).to.equal(trace[0].trace_id.toString(10))
    expect(spanEvent.content.span_id.toString(10)).to.equal(trace[0].span_id.toString(10))
    expect(spanEvent.content.parent_id.toString(10)).to.equal(trace[0].parent_id.toString(10))
    expect(spanEvent.content).to.contain({
      name: 'test',
      resource: 'test-r',
      service: 'test-s',
      type: 'foo'
    })
    expect(spanEvent.content.error.toNumber()).to.equal(0)
    expect(spanEvent.content.start.toNumber()).to.equal(123)
    expect(spanEvent.content.duration.toNumber()).to.equal(456)

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
  })

  it('should report its count', () => {
    expect(encoder.count()).to.equal(0)

    encoder.encode(trace)

    expect(encoder.count()).to.equal(1)

    encoder.encode(trace)

    expect(encoder.count()).to.equal(2)
  })

  it('should reset after making a payload', () => {
    encoder.encode(trace)
    encoder.makePayload()

    expect(encoder.count()).to.equal(0)
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
    const decodedTrace = msgpack.decode(buffer, { codec })

    expect(decodedTrace)
    const spanEvent = decodedTrace.events[0]
    expect(spanEvent.content.type.length).to.equal(MAX_TYPE_LENGTH)
    expect(spanEvent.content.name.length).to.equal(MAX_NAME_LENGTH)
    expect(spanEvent.content.service.length).to.equal(MAX_SERVICE_LENGTH)
    // ellipsis is added
    expect(spanEvent.content.resource.length).to.equal(MAX_RESOURCE_NAME_LENGTH + 3)
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
    const decodedTrace = msgpack.decode(buffer, { codec })

    expect(decodedTrace)
    const spanEvent = decodedTrace.events[0]
    expect(spanEvent.content.service).to.equal(DEFAULT_SERVICE_NAME)
    expect(spanEvent.content.name).to.equal(DEFAULT_SPAN_NAME)
  })

  it('should cut too long meta and metrics keys and values', () => {
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
        [tooLongKey]: tooLongValue
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
    const decodedTrace = msgpack.decode(buffer, { codec })
    const spanEvent = decodedTrace.events[0]
    expect(spanEvent.content.meta).to.eql({
      [`${tooLongKey.slice(0, MAX_META_KEY_LENGTH)}...`]: `${tooLongValue.slice(0, MAX_META_VALUE_LENGTH)}...`
    })
    expect(spanEvent.content.metrics).to.eql({
      [`${tooLongKey.slice(0, MAX_METRIC_KEY_LENGTH)}...`]: `${tooLongValue.slice(0, MAX_METRIC_VALUE_LENGTH)}...`
    })
  })
})
