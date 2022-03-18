'use strict'

const { expect } = require('chai')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const id = require('../../src/id')
const Chunk = require('../../src/encode/chunk')
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
        float: 1.23456712345
      },
      start: 123,
      duration: 456
    }]
  })

  it('should encode to msgpack', () => {
    encoder.append(trace)

    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { codec })

    expect(decodedTrace.version).to.equal(1)
    expect(decodedTrace.metadata).to.contain({
      language: 'javascript',
      'runtime.name': 'node',
      'runtime.version':
      process.version
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
      type: 'foo',
      error: 0,
      start: 123,
      duration: 456
    })
    expect(spanEvent.content.meta).to.eql({
      bar: 'baz'
    })
    expect(spanEvent.content.metrics).to.eql({
      positive: 123456712345,
      negative: -123456712345,
      float: 1.23456712345
    })
  })

  it('should report its count', () => {
    expect(encoder.count()).to.equal(0)

    encoder.append(trace)

    expect(encoder.count()).to.equal(1)

    encoder.append(trace)

    expect(encoder.count()).to.equal(2)
  })

  it('should reset after making a payload', () => {
    encoder.append(trace)
    encoder.makePayload()

    expect(encoder.count()).to.equal(0)
  })

  it('should log adding an encoded trace to the buffer', () => {
    encoder._encode(new Chunk())

    const message = logger.debug.firstCall.args[0]()

    expect(message).to.match(/Adding encoded trace to buffer/)
  })

  it('should truncate name, service, type and resource when they are too long', () => {
    const tooLongString = new Array(500).fill('a').join('')
    const resourceTooLongString = new Array(10000).fill('a').join('')
    const traceToTruncate = [{
      name: tooLongString,
      resource: resourceTooLongString,
      type: tooLongString,
      service: tooLongString
    }]
    encoder.append(traceToTruncate)

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
      resource: 'resource'
    }]
    encoder.append(traceToTruncate)

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
      meta: {
        [tooLongKey]: tooLongValue
      },
      metrics: {
        [tooLongKey]: tooLongValue
      }
    }]
    encoder.append(traceToTruncate)

    const buffer = encoder.makePayload()
    const decodedTrace = msgpack.decode(buffer, { codec })

    expect(decodedTrace)
    const spanEvent = decodedTrace.events[0]
    expect(spanEvent.content.meta).to.eql({
      [`${tooLongKey.slice(0, MAX_META_KEY_LENGTH)}...`]: `${tooLongValue.slice(0, MAX_META_VALUE_LENGTH)}...`
    })
    expect(spanEvent.content.metrics).to.eql({
      [`${tooLongKey.slice(0, MAX_METRIC_KEY_LENGTH)}...`]: `${tooLongValue.slice(0, MAX_METRIC_VALUE_LENGTH)}...`
    })
  })
})
