'use strict'

const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const Uint64BE = require('int64-buffer').Uint64BE

describe('encode', () => {
  let encode

  beforeEach(() => {
    encode = require('../src/encode')
  })

  it('should encode to msgpack', () => {
    const data = [{
      id: new Uint64BE(0x12345678, 0x12345678),
      name: 'test'
    }]

    const buffer = encode(data)
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded).to.be.instanceof(Array)
    expect(decoded[0]).to.be.instanceof(Object)
    expect(decoded[0].id.toString()).to.equal(data[0].id.toString())
    expect(decoded[0].name).to.equal(data[0].name)
  })
})
