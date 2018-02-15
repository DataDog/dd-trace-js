'use strict'

const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const Uint64BE = require('int64-buffer').Uint64BE
const Buffer = require('safe-buffer').Buffer

const concat = buffers => Buffer.concat(buffers.map(Buffer.from))

describe('encode', () => {
  let encode
  let trace

  beforeEach(() => {
    trace = [{
      trace_id: new Uint64BE(Buffer.alloc(8, 0x01)),
      span_id: new Uint64BE(Buffer.alloc(8, 0x02)),
      parent_id: null,
      name: 'root',
      resource: '/',
      service: 'benchmark',
      type: 'web',
      error: 0,
      meta: { foo: 'bar' },
      start: 1500000000000123600,
      duration: 100000000
    }]
    encode = require('../src/encode')
  })

  it('should encode to msgpack', () => {
    const buffer = concat(encode(trace))
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded).to.be.instanceof(Array)
    expect(decoded[0]).to.be.instanceof(Object)
    expect(decoded[0].trace_id.toString()).to.equal(trace[0].trace_id.toString())
    expect(decoded[0].span_id.toString()).to.equal(trace[0].span_id.toString())
    expect(decoded[0].parent_id).to.equal(trace[0].parent_id)
    expect(decoded[0].name).to.equal(trace[0].name)
    expect(decoded[0].resource).to.equal(trace[0].resource)
    expect(decoded[0].service).to.equal(trace[0].service)
    expect(decoded[0].type).to.equal(trace[0].type)
    expect(decoded[0].error).to.equal(trace[0].error)
    expect(decoded[0].meta).to.deep.equal(trace[0].meta)
    expect(decoded[0].start.toString()).to.equal('1500000000000123648') // precision loss
    expect(decoded[0].duration.toString()).to.equal(trace[0].duration.toString())
  })

  it('should encode the parent ID', () => {
    trace[0].parent_id = new Uint64BE(Buffer.alloc(8, 0x03))

    const buffer = concat(encode(trace))
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].parent_id.toString()).to.deep.equal(trace[0].parent_id.toString())
  })

  it('should encode str8', () => {
    let str = ''

    for (let i = 0; i < 128; i++) {
      str += 'a'
    }

    trace[0].meta.foo = str

    const buffer = concat(encode(trace))
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].meta).to.deep.equal(trace[0].meta)
  })

  it('should encode str16', () => {
    let str = ''

    for (let i = 0; i < 256; i++) {
      str += 'a'
    }

    trace[0].meta.foo = str

    const buffer = concat(encode(trace))
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].meta).to.deep.equal(trace[0].meta)
  })

  it('should encode str32', () => {
    let str = ''

    for (let i = 0; i < 65536; i++) {
      str += 'a'
    }

    trace[0].meta.foo = str

    const buffer = concat(encode(trace))
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].meta).to.deep.equal(trace[0].meta)
  })

  it('should encode int8', () => {
    trace[0].start = 128
    trace[0].duration = 128

    const buffer = concat(encode(trace))
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].start).to.deep.equal(trace[0].start)
    expect(decoded[0].duration).to.deep.equal(trace[0].duration)
  })

  it('should encode int16', () => {
    trace[0].start = 256
    trace[0].duration = 256

    const buffer = concat(encode(trace))
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].start).to.deep.equal(trace[0].start)
    expect(decoded[0].duration).to.deep.equal(trace[0].duration)
  })

  it('should encode int32', () => {
    trace[0].start = 65536
    trace[0].duration = 65536

    const buffer = concat(encode(trace))
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].start).to.deep.equal(trace[0].start)
    expect(decoded[0].duration).to.deep.equal(trace[0].duration)
  })

  it('should encode int64', () => {
    trace[0].start = 4294967296
    trace[0].duration = 4294967296

    const buffer = concat(encode(trace))
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].start.toString()).to.deep.equal(trace[0].start.toString())
    expect(decoded[0].duration.toString()).to.deep.equal(trace[0].duration.toString())
  })

  it('should encode array16', () => {
    for (let i = 0; i < 255; i++) {
      trace.push(trace[0])
    }

    const buffer = concat(encode(trace))
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded).to.have.length(256)
  })

  it('should encode utf-8 strings', () => {
    trace[0].meta['ƒơơ'] = 'ƃăř'

    const buffer = concat(encode(trace))
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].meta).to.have.property('ƒơơ', trace[0].meta['ƒơơ'])
  })
})
