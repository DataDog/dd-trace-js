'use strict'

const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const Uint64BE = require('int64-buffer').Uint64BE
const Buffer = require('safe-buffer').Buffer

describe('encode', () => {
  let encode
  let trace
  let buffer

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

    buffer = Buffer.alloc(8 * 1024 * 1024)
    encode = require('../src/encode')
  })

  it('should encode to msgpack', () => {
    encode(buffer, 0, trace)

    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded).to.be.instanceof(Array)
    expect(decoded[0]).to.be.instanceof(Object)
    expect(decoded[0].trace_id.toString()).to.equal(trace[0].trace_id.toString())
    expect(decoded[0].span_id.toString()).to.equal(trace[0].span_id.toString())
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

    encode(buffer, 0, trace)

    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].parent_id.toString()).to.deep.equal(trace[0].parent_id.toString())
  })

  it('should encode str8', () => {
    let str = ''

    for (let i = 0; i < 128; i++) {
      str += 'a'
    }

    trace[0].meta.foo = str

    encode(buffer, 0, trace)

    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].meta).to.deep.equal(trace[0].meta)
  })

  it('should encode str16', () => {
    let str = ''

    for (let i = 0; i < 256; i++) {
      str += 'a'
    }

    trace[0].meta.foo = str

    encode(buffer, 0, trace)

    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].meta).to.deep.equal(trace[0].meta)
  })

  it('should encode str32', () => {
    let str = ''

    for (let i = 0; i < 65536; i++) {
      str += 'a'
    }

    trace[0].meta.foo = str

    encode(buffer, 0, trace)

    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].meta).to.deep.equal(trace[0].meta)
  })

  it('should encode array16', () => {
    for (let i = 0; i < 255; i++) {
      trace.push(trace[0])
    }

    encode(buffer, 0, trace)

    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded).to.have.length(256)
  })

  it('should encode array32', () => {
    encode(buffer, 0, new Array(65537))

    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded).to.have.length(65537)
  })

  it('should encode utf-8 strings', () => {
    trace[0].meta['ƒơơ'] = 'ƃăř'

    encode(buffer, 0, trace)

    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded[0].meta).to.have.property('ƒơơ', trace[0].meta['ƒơơ'])
  })
})
