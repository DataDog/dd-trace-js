'use strict'

const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const id = require('../src/id')
const { Int64BE } = require('int64-buffer') // TODO: remove dependency

describe('encode', () => {
  let encode

  beforeEach(() => {
    encode = require('../src/encode')
  })

  it('should encode to msgpack', () => {
    const data = [{
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

    let buffer = Buffer.alloc(1024)
    const offset = encode(buffer, 0, data, {})
    buffer = buffer.slice(0, offset)

    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded).to.be.instanceof(Array)
    expect(decoded[0]).to.be.instanceof(Object)
    expect(decoded[0].trace_id.toString(16)).to.equal(data[0].trace_id.toString())
    expect(decoded[0].span_id.toString(16)).to.equal(data[0].span_id.toString())
    expect(decoded[0].parent_id.toString(16)).to.equal(data[0].parent_id.toString())
    expect(decoded[0].start).to.be.instanceof(Int64BE)
    expect(decoded[0].start.toString()).to.equal(data[0].start.toString())
    expect(decoded[0].duration).to.be.instanceof(Int64BE)
    expect(decoded[0].duration.toString()).to.equal(data[0].duration.toString())
    expect(decoded[0].name).to.equal(data[0].name)
    expect(decoded[0].meta).to.deep.equal({ bar: 'baz' })
    expect(decoded[0].metrics).to.deep.equal({ example: 1 })
  })

  it('should truncate long IDs', () => {
    const data = [{
      trace_id: id('ffffffffffffffff1234abcd1234abcd'),
      span_id: id('ffffffffffffffff1234abcd1234abcd'),
      parent_id: id('ffffffffffffffff1234abcd1234abcd'),
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

    let buffer = Buffer.alloc(1024)
    const offset = encode(buffer, 0, data, {})
    buffer = buffer.slice(0, offset)

    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].trace_id.toString(16)).to.equal('1234abcd1234abcd')
    expect(decoded[0].span_id.toString(16)).to.equal('1234abcd1234abcd')
    expect(decoded[0].parent_id.toString(16)).to.equal('1234abcd1234abcd')
  })
})
