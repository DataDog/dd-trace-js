'use strict'

const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const id = require('../src/id')

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
      start: 123,
      duration: 456,
      name: 'test'
    }]

    const buffer = encode(data)
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded).to.be.instanceof(Array)
    expect(decoded[0]).to.be.instanceof(Object)
    expect(decoded[0].trace_id.toString(16)).to.equal(data[0].trace_id.toString())
    expect(decoded[0].span_id.toString(16)).to.equal(data[0].span_id.toString())
    expect(decoded[0].parent_id.toString(16)).to.equal(data[0].parent_id.toString())
    expect(decoded[0].start.toString()).to.equal(data[0].start.toString())
    expect(decoded[0].duration.toString()).to.equal(data[0].duration.toString())
    expect(decoded[0].name).to.equal(data[0].name)
  })
})
