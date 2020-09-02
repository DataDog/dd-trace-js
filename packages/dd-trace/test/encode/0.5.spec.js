'use strict'

const msgpack = require('msgpack-lite')
const platform = require('../../src/platform')
const codec = msgpack.createCodec({ int64: true })
const id = require('../../src/id')
const { Int64BE } = require('int64-buffer') // TODO: remove dependency

describe('encode 0.5', () => {
  let encode
  let makePayload
  let writer

  beforeEach(() => {
    platform.use(require('../../src/platform/node'))
    const encoder = require('../../src/encode/0.5')
    encode = encoder.encode
    makePayload = encoder.makePayload
    encoder.init()
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
    const offset = encode(buffer, 5, data, writer)
    buffer = buffer.slice(0, offset)
    const traceData = platform.msgpack.prefix(buffer, 1)
    const [payload] = makePayload(traceData)

    const decoded = msgpack.decode(payload, { codec })

    const stringMap = decoded[0]
    const trace = decoded[1][0]

    expect(trace).to.be.instanceof(Array)
    expect(trace[0]).to.be.instanceof(Array)
    expect(stringMap[trace[0][0]]).to.equal(data[0].service)
    expect(stringMap[trace[0][1]]).to.equal(data[0].name)
    expect(stringMap[trace[0][2]]).to.equal(data[0].resource)
    expect(trace[0][3].toString(16)).to.equal(data[0].trace_id.toString())
    expect(trace[0][4].toString(16)).to.equal(data[0].span_id.toString())
    expect(trace[0][5].toString(16)).to.equal(data[0].parent_id.toString())
    expect(trace[0][6]).to.be.instanceof(Int64BE)
    expect(trace[0][6].toString()).to.equal(data[0].start.toString())
    expect(trace[0][7]).to.be.instanceof(Int64BE)
    expect(trace[0][7].toString()).to.equal(data[0].duration.toString())
    expect(trace[0][8]).to.equal(0)
    expect(trace[0][9]).to.deep.equal({ [stringMap.indexOf('bar')]: stringMap.indexOf('baz') })
    expect(trace[0][10]).to.deep.equal({ [stringMap.indexOf('example')]: 1 })
    expect(stringMap[trace[0][11]]).to.equal(data[0].type)
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
