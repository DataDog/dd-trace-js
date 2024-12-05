'use strict'

require('../setup/tap')

const { expect } = require('chai')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })
const { MsgpackEncoder } = require('../../src/msgpack/encoder')

function randString (length) {
  return Array.from({ length }, () => {
    return String.fromCharCode(Math.floor(Math.random() * 256))
  }).join('')
}

describe('msgpack/encoder', () => {
  let encoder

  beforeEach(() => {
    encoder = new MsgpackEncoder()
  })

  it('should encode to msgpack', () => {
    const data = [
      { first: 'test' },
      {
        fixstr: 'foo',
        str: randString(1000),
        fixuint: 127,
        fixint: -31,
        uint8: 255,
        uint16: 65535,
        uint32: 4294967295,
        int8: -15,
        int16: -32767,
        int32: -2147483647,
        float: 12345.6789,
        biguint: BigInt('9223372036854775807'),
        bigint: BigInt('-9223372036854775807')
      }
    ]

    const buffer = encoder.encode(data)
    const decoded = msgpack.decode(buffer, { codec })

    expect(decoded).to.be.an('array')
    expect(decoded[0]).to.be.an('object')
    expect(decoded[0]).to.have.property('first', 'test')
    expect(decoded[1]).to.be.an('object')
    expect(decoded[1]).to.have.property('fixstr', 'foo')
    expect(decoded[1]).to.have.property('str')
    expect(decoded[1].str).to.have.length(1000)
    expect(decoded[1]).to.have.property('fixuint', 127)
    expect(decoded[1]).to.have.property('fixint', -31)
    expect(decoded[1]).to.have.property('uint8', 255)
    expect(decoded[1]).to.have.property('uint16', 65535)
    expect(decoded[1]).to.have.property('uint32', 4294967295)
    expect(decoded[1]).to.have.property('int8', -15)
    expect(decoded[1]).to.have.property('int16', -32767)
    expect(decoded[1]).to.have.property('int32', -2147483647)
    expect(decoded[1]).to.have.property('float', 12345.6789)
    expect(decoded[1]).to.have.property('biguint')
    expect(decoded[1].biguint.toString()).to.equal('9223372036854775807')
    expect(decoded[1]).to.have.property('bigint')
    expect(decoded[1].bigint.toString()).to.equal('-9223372036854775807')
  })
})
