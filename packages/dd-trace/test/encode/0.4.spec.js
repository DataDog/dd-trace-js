'use strict'

const { expect } = require('chai')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const id = require('../../src/id')

describe('encode', () => {
  let encoder
  let writer
  let data

  beforeEach(() => {
    const { AgentEncoder } = require('../../src/encode/0.4')
    writer = { flush: sinon.spy() }
    encoder = new AgentEncoder(writer)
    data = [{
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
        example: 1
      },
      start: 123,
      duration: 456
    }]
  })

  it('should encode to msgpack', () => {
    encoder.encode(data)

    const buffer = Buffer.concat(encoder.makePayload())
    const decoded = msgpack.decode(buffer, { codec })
    const trace = decoded[0]

    expect(trace).to.be.instanceof(Array)
    expect(trace[0]).to.be.instanceof(Object)
    expect(trace[0].trace_id.toString(16)).to.equal(data[0].trace_id.toString())
    expect(trace[0].span_id.toString(16)).to.equal(data[0].span_id.toString())
    expect(trace[0].parent_id.toString(16)).to.equal(data[0].parent_id.toString())
    expect(trace[0].start).to.equal(123)
    expect(trace[0].duration).to.equal(456)
    expect(trace[0].name).to.equal(data[0].name)
    expect(trace[0].meta).to.deep.equal({ bar: 'baz' })
    expect(trace[0].metrics).to.deep.equal({ example: 1 })
  })

  it('should truncate long IDs', () => {
    data[0].trace_id = id('ffffffffffffffff1234abcd1234abcd')
    data[0].span_id = id('ffffffffffffffff1234abcd1234abcd')
    data[0].arent_id = id('ffffffffffffffff1234abcd1234abcd')

    encoder.encode(data)

    const buffer = Buffer.concat(encoder.makePayload())
    const decoded = msgpack.decode(buffer, { codec })
    const trace = decoded[0]

    expect(trace[0].trace_id.toString(16)).to.equal('1234abcd1234abcd')
    expect(trace[0].span_id.toString(16)).to.equal('1234abcd1234abcd')
    expect(trace[0].parent_id.toString(16)).to.equal('1234abcd1234abcd')
  })

  it('should report its count', () => {
    expect(encoder.count()).to.equal(0)

    encoder.encode(data)

    expect(encoder.count()).to.equal(1)

    encoder.encode(data)

    expect(encoder.count()).to.equal(2)
  })

  it('should flush when the payload size limit is reached', () => {
    data[0].meta.foo = new Array(8 * 1024 * 1024).join('a')

    encoder.encode(data)

    expect(writer.flush).to.have.been.called
  })

  it('should reset after making a payload', () => {
    encoder.encode(data)
    encoder.makePayload()

    const payload = encoder.makePayload()

    expect(encoder.count()).to.equal(0)
    expect(payload).to.have.length(1)
    expect(payload[0]).to.have.length(5)
    expect(payload[0][4]).to.equal(0)
  })
})
