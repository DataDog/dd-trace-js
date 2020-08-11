'use strict'

const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const id = require('../src/id')
const { Int64BE } = require('int64-buffer') // TODO: remove dependency

describe('encode 0.5', () => {
  let encode
  let writer

  beforeEach(() => {
    encode = require('../src/encode/index-0.5')

    writer = {}
    writer._strings = Buffer.allocUnsafe(1024 * 1024)
    writer._stringMap = {}
    writer._stringsBufLen = 3
    writer._strings[0] = 0xdc
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
    const offset = encode(buffer, 0, data, writer)
    buffer = buffer.slice(0, offset)

    const decoded = msgpack.decode(buffer, { codec })
    const stringMap = Reflect.ownKeys(writer._stringMap)

    expect(decoded).to.be.instanceof(Array)
    expect(decoded[0]).to.be.instanceof(Array)
    expect(stringMap[decoded[0][0]]).to.equal(data[0].service)
    expect(stringMap[decoded[0][1]]).to.equal(data[0].name)
    expect(stringMap[decoded[0][2]]).to.equal(data[0].resource)
    expect(decoded[0][3].toString(16)).to.equal(data[0].trace_id.toString())
    expect(decoded[0][4].toString(16)).to.equal(data[0].span_id.toString())
    expect(decoded[0][5].toString(16)).to.equal(data[0].parent_id.toString())
    expect(decoded[0][6]).to.be.instanceof(Int64BE)
    expect(decoded[0][6].toString()).to.equal(data[0].start.toString())
    expect(decoded[0][7]).to.be.instanceof(Int64BE)
    expect(decoded[0][7].toString()).to.equal(data[0].duration.toString())
    expect(decoded[0][8]).to.equal(0)
    expect(decoded[0][9]).to.deep.equal({ [writer._stringMap.bar]: writer._stringMap.baz })
    expect(decoded[0][10]).to.deep.equal({ [writer._stringMap.example]: 1 })
    expect(stringMap[decoded[0][11]]).to.equal(data[0].type)
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
    const offset = encode(buffer, 0, data, writer)
    buffer = buffer.slice(0, offset)

    const decoded = msgpack.decode(buffer, { codec })
    expect(decoded[0][3].toString(16)).to.equal('1234abcd1234abcd')
    expect(decoded[0][4].toString(16)).to.equal('1234abcd1234abcd')
    expect(decoded[0][5].toString(16)).to.equal('1234abcd1234abcd')
  })
})
