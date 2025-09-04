'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
const msgpack = require('@msgpack/msgpack')

require('../setup/core')

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
        uint53: 9007199254740991,
        int8: -15,
        int16: -32767,
        int32: -2147483647,
        int53: -9007199254740991,
        float: 12345.6789,
        biguint: BigInt('9223372036854775807'),
        bigint: BigInt('-9223372036854775807'),
        buffer: Buffer.from('test'),
        uint8array: new Uint8Array([1, 2, 3, 4])
      }
    ]

    const buffer = encoder.encode(data)
    const decoded = msgpack.decode(buffer, { useBigInt64: true })

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
    expect(decoded[1]).to.have.property('uint53')
    expect(decoded[1].uint53.toString()).to.equal('9007199254740991')
    expect(decoded[1]).to.have.property('int8', -15)
    expect(decoded[1]).to.have.property('int16', -32767)
    expect(decoded[1]).to.have.property('int32', -2147483647)
    expect(decoded[1]).to.have.property('int53')
    expect(decoded[1].int53.toString()).to.equal('-9007199254740991')
    expect(decoded[1]).to.have.property('float', 12345.6789)
    expect(decoded[1]).to.have.property('biguint')
    expect(decoded[1].biguint.toString()).to.equal('9223372036854775807')
    expect(decoded[1]).to.have.property('bigint')
    expect(decoded[1].bigint.toString()).to.equal('-9223372036854775807')
    expect(decoded[1]).to.have.property('buffer')
    expect(decoded[1].buffer.toString('utf8')).to.equal('test')
    expect(decoded[1]).to.have.property('buffer')
    expect(decoded[1].buffer.toString('utf8')).to.equal('test')
    expect(decoded[1]).to.have.property('uint8array')
    expect(decoded[1].uint8array[0]).to.equal(1)
    expect(decoded[1].uint8array[1]).to.equal(2)
    expect(decoded[1].uint8array[2]).to.equal(3)
    expect(decoded[1].uint8array[3]).to.equal(4)
  })
})
